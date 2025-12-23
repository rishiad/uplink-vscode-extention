use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use russh::*;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

static SESSIONS: Lazy<Mutex<HashMap<u32, Arc<client::Handle<Client>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[napi]
pub fn load_ssh_key_info(key_path: String) -> Result<String> {
    match russh::keys::load_secret_key(&key_path, None) {
        Ok(_) => Ok(format!("Successfully loaded key: {}", key_path)),
        Err(e) => Err(napi::Error::new(Status::GenericFailure, format!("Load: {}", e)))
    }
}

#[napi]
pub fn test_certificate_detection(cert_path: String) -> Result<bool> {
    use std::fs;
    match fs::read_to_string(&cert_path) {
        Ok(content) => Ok(content.contains("-cert-v01@openssh.com")),
        Err(e) => Err(napi::Error::new(Status::GenericFailure, format!("Read: {}", e)))
    }
}

struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &keys::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

#[napi]
pub async fn ssh_connect(
    host: String,
    port: u16,
    username: String,
    key_path: String,
    cert_path: Option<String>,
) -> Result<u32> {
    let key_pair = russh::keys::load_secret_key(&key_path, None)
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Key load: {}", e)))?;

    let openssh_cert = if let Some(cert_path) = cert_path {
        Some(russh::keys::load_openssh_certificate(&cert_path)
            .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Cert load: {}", e)))?)
    } else {
        None
    };

    let config = Arc::new(client::Config::default());
    let sh = Client {};

    let mut session = client::connect(config, (host.as_str(), port), sh)
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Connect: {}", e)))?;

    let auth_res = if let Some(cert) = openssh_cert {
        session.authenticate_openssh_cert(username, Arc::new(key_pair), cert).await
    } else {
        session.authenticate_publickey(username, keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)).await
    }.map_err(|e| napi::Error::new(Status::GenericFailure, format!("Auth: {}", e)))?;

    if !auth_res.success() {
        return Err(napi::Error::new(Status::GenericFailure, "Auth failed"));
    }

    let mut sessions = SESSIONS.lock();
    let session_id = sessions.len() as u32;
    sessions.insert(session_id, Arc::new(session));

    Ok(session_id)
}

#[napi]
pub async fn ssh_exec(session_id: u32, command: String) -> Result<String> {
    let session = {
        let sessions = SESSIONS.lock();
        sessions.get(&session_id)
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "Invalid session"))?
            .clone()
    };

    let mut channel = session.channel_open_session().await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Channel: {}", e)))?;

    channel.exec(true, command).await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Exec: {}", e)))?;

    let mut output = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => output.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => break,
            _ => {}
        }
    }

    Ok(String::from_utf8_lossy(&output).to_string())
}

#[napi]
pub async fn ssh_forward_port(
    session_id: u32,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<u16> {
    let session = {
        let sessions = SESSIONS.lock();
        sessions.get(&session_id)
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "Invalid session"))?
            .clone()
    };

    let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Bind: {}", e)))?;

    let actual_port = listener.local_addr()
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Port: {}", e)))?
        .port();

    tokio::spawn(async move {
        loop {
            if let Ok((stream, addr)) = listener.accept().await {
                let session = session.clone();
                let remote_host = remote_host.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_forward(stream, session, addr, remote_host, remote_port).await {
                        eprintln!("Forward error: {}", e);
                    }
                });
            }
        }
    });

    Ok(actual_port)
}

async fn handle_forward(
    mut stream: TcpStream,
    session: Arc<client::Handle<Client>>,
    originator_addr: std::net::SocketAddr,
    remote_host: String,
    remote_port: u16,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut channel = session
        .channel_open_direct_tcpip(
            remote_host,
            remote_port as u32,
            originator_addr.ip().to_string(),
            originator_addr.port() as u32,
        )
        .await?;

    let mut stream_closed = false;
    let mut channel_closed = false;
    let mut buf = vec![0; 65536];

    loop {
        tokio::select! {
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => {
                        stream_closed = true;
                        let _ = channel.eof().await;
                        if channel_closed {
                            break;
                        }
                    },
                    Ok(n) => {
                        if let Err(_) = channel.data(&buf[..n]).await {
                            break;
                        }
                    },
                    Err(_) => break,
                }
            },
            Some(msg) = channel.wait() => {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        if let Err(_) = stream.write_all(data).await {
                            break;
                        }
                    }
                    ChannelMsg::Eof => {
                        channel_closed = true;
                        let _ = stream.shutdown().await;
                        if stream_closed {
                            break;
                        }
                    }
                    ChannelMsg::ExitStatus { .. } => {
                        channel_closed = true;
                        if stream_closed {
                            break;
                        }
                    }
                    ChannelMsg::WindowAdjusted { .. } => {}
                    _ => {}
                }
            },
            else => break,
        }
    }

    Ok(())
}

#[napi]
pub async fn ssh_upload_file(session_id: u32, local_path: String, remote_path: String) -> Result<()> {
    let session = {
        let sessions = SESSIONS.lock();
        sessions.get(&session_id)
            .ok_or_else(|| napi::Error::new(Status::GenericFailure, "Invalid session"))?
            .clone()
    };

    let local_data = tokio::fs::read(&local_path).await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Read file: {}", e)))?;

    let channel = session.channel_open_session().await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Channel: {}", e)))?;

    channel.request_subsystem(true, "sftp").await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("SFTP: {}", e)))?;

    let sftp = SftpSession::new(channel.into_stream()).await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("SFTP session: {}", e)))?;

    let mut file = sftp.open_with_flags(
        &remote_path,
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
    ).await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Open: {}", e)))?;

    file.write_all(&local_data).await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Write: {}", e)))?;

    file.flush().await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Flush: {}", e)))?;

    file.shutdown().await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Close: {}", e)))?;

    Ok(())
}

#[napi]
pub async fn ssh_disconnect(session_id: u32) -> Result<()> {
    let session = {
        let mut sessions = SESSIONS.lock();
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        session.disconnect(Disconnect::ByApplication, "", "en").await
            .map_err(|e| napi::Error::new(Status::GenericFailure, format!("Disconnect: {}", e)))?;
    }

    Ok(())
}
