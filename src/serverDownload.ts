import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Log from './common/logger';
import SSHConnection from './ssh/sshConnection';


export interface RemoteSystemInfo {
    arch: 'x64' | 'arm64';
    libc: 'glibc' | 'musl';
    glibcVersion?: string;
}

export async function detectRemoteSystem(conn: SSHConnection, logger: Log): Promise<RemoteSystemInfo> {
    // Detect architecture
    const archResult = await conn.exec('uname -m');
    const archOutput = archResult.stdout.trim();
    let arch: 'x64' | 'arm64';
    
    if (archOutput === 'x86_64' || archOutput === 'amd64') {
        arch = 'x64';
    } else if (archOutput === 'aarch64' || archOutput === 'arm64') {
        arch = 'arm64';
    } else {
        throw new Error(`Unsupported architecture: ${archOutput}`);
    }

    logger.trace(`Detected remote system: arch=${arch}`);
    
    return { arch, libc: 'glibc' };
}

export function getLocalServerPath(systemInfo: RemoteSystemInfo, logger?: Log): string | undefined {
    const config = vscode.workspace.getConfiguration('remote.SSH');
    const localDistPath = config.get<string>('localServerDistPath', '');
    
    if (!localDistPath) {
        return undefined;
    }
    
    const serverVersion = config.get<string>('serverVersion', '0.1.1');
    const { arch } = systemInfo;
    const filename = `uplink-server-${arch}-${serverVersion}.tar.gz`;
    const fullPath = path.join(localDistPath, filename);
    
    logger?.trace(`Checking for local server at: ${fullPath}`);
    
    if (fs.existsSync(fullPath)) {
        return fullPath;
    }
    
    logger?.trace(`Local server not found at: ${fullPath}`);
    return undefined;
}

export function getServerDownloadUrl(systemInfo: RemoteSystemInfo): string {
    const config = vscode.workspace.getConfiguration('remote.SSH');
    const serverRepo = config.get<string>('serverRepository', 'rishiad/uplink-server');
    const serverVersion = config.get<string>('serverVersion', '0.1.0');
    
    const { arch } = systemInfo;
    return `https://github.com/${serverRepo}/releases/download/v${serverVersion}/uplink-server-${arch}-${serverVersion}.tar.gz`;
}

export async function downloadServerOnRemote(
    conn: SSHConnection,
    url: string,
    destPath: string,
    logger: Log,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
    logger.trace(`Downloading server on remote from ${url}`);
    
    // Create directory
    const destDir = destPath.substring(0, destPath.lastIndexOf('/'));
    await conn.exec(`mkdir -p '${destDir}'`);
    
    // Download with curl showing progress
    const downloadScript = `
set -e
TMP_FILE="${destPath}.tmp"
rm -f "$TMP_FILE"

if command -v curl >/dev/null 2>&1; then
    curl -L --progress-bar -o "$TMP_FILE" "${url}" 2>&1 | 
    while IFS= read -r line; do
        if [[ "$line" =~ ([0-9]+)\.[0-9]+% ]]; then
            echo "PROGRESS:\${BASH_REMATCH[1]}"
        fi
    done
elif command -v wget >/dev/null 2>&1; then
    wget --progress=dot:mega -O "$TMP_FILE" "${url}" 2>&1 |
    while IFS= read -r line; do
        if [[ "$line" =~ ([0-9]+)% ]]; then
            echo "PROGRESS:\${BASH_REMATCH[1]}"
        fi
    done
else
    echo "Error: Neither curl nor wget found"
    exit 1
fi

mv "$TMP_FILE" "${destPath}"
echo "DOWNLOAD_COMPLETE"
`;
    
    const result = await conn.exec(`bash -c '${downloadScript.replace(/'/g, `'\\''`)}'`);
    
    const lines = result.stdout.split('\n');
    let lastPercent = 0;
    for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
            const percent = parseInt(line.substring(9), 10);
            if (percent > lastPercent) {
                const increment = percent - lastPercent;
                progress.report({ 
                    increment,
                    message: `${percent}% complete`
                });
                lastPercent = percent;
            }
        }
    }
    
    if (!result.stdout.includes('DOWNLOAD_COMPLETE')) {
        throw new Error(`Download failed: ${result.stderr || 'Unknown error'}`);
    }
    
    logger.trace(`Server downloaded to ${destPath} on remote`);
}

export async function uploadLocalServer(
    conn: SSHConnection,
    localPath: string,
    remotePath: string,
    logger: Log
): Promise<void> {
    logger.trace(`Uploading local server from ${localPath} to ${remotePath}`);
    
    // Create remote directory
    const destDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await conn.exec(`mkdir -p '${destDir}'`);
    
    // Upload file
    await conn.uploadFile(localPath, remotePath);
    
    logger.trace(`Server uploaded to ${remotePath}`);
}

export async function getOrDownloadServerOnRemote(
    conn: SSHConnection,
    remoteServerDir: string,
    logger: Log
): Promise<string> {
    const systemInfo = await detectRemoteSystem(conn, logger);
    
    // Remote cache path
    const remoteCacheDir = `${remoteServerDir}/cache`;
    const remoteServerPath = `${remoteCacheDir}/server.tar.gz`;
    
    // Check for local dist folder first
    const localServerPath = getLocalServerPath(systemInfo, logger);
    if (localServerPath) {
        logger.trace(`Using local server from ${localServerPath}`);
        await uploadLocalServer(conn, localServerPath, remoteServerPath, logger);
        return remoteServerPath;
    }
    
    logger.trace('No local server archive specified, downloading from GitHub releases...');
    
    const downloadUrl = getServerDownloadUrl(systemInfo);
    
    // Check if already cached on remote
    const checkResult = await conn.exec(`if [ -f '${remoteServerPath}' ]; then echo exists; fi`);
    if (checkResult.stdout.trim() === 'exists') {
        logger.trace(`Using cached server from ${remoteServerPath}`);
        return remoteServerPath;
    }
    
    // Download on remote with progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading server on remote host',
        cancellable: false
    }, async (progress) => {
        await downloadServerOnRemote(conn, downloadUrl, remoteServerPath, logger, progress);
    });
    
    return remoteServerPath;
}
