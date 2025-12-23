const { loadSshKeyInfo, testCertificateDetection, sshConnect, sshExec, sshForwardPort, sshUploadFile, sshDisconnect } = require('../uplink-ssh.darwin-arm64.node');

export function loadSSHKeyInfo(keyPath: string): string {
    return loadSshKeyInfo(keyPath);
}

export function isCertificateFile(certPath: string): boolean {
    return testCertificateDetection(certPath);
}

export async function connect(host: string, port: number, username: string, keyPath: string, certPath?: string): Promise<number> {
    return sshConnect(host, port, username, keyPath, certPath);
}

export async function exec(sessionId: number, command: string): Promise<string> {
    return sshExec(sessionId, command);
}

export async function forwardPort(sessionId: number, localPort: number, remoteHost: string, remotePort: number): Promise<number> {
    return sshForwardPort(sessionId, localPort, remoteHost, remotePort);
}

export async function disconnect(sessionId: number): Promise<void> {
    return sshDisconnect(sessionId);
}

export async function uploadFile(sessionId: number, localPath: string, remotePath: string): Promise<void> {
    return sshUploadFile(sessionId, localPath, remotePath);
}