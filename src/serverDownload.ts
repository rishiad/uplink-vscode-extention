import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
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

export function getServerDownloadUrl(systemInfo: RemoteSystemInfo): string {
    const config = vscode.workspace.getConfiguration('remote.SSH');
    const serverRepo = config.get<string>('serverRepository', 'rishiad/uplink-server');
    const serverVersion = config.get<string>('serverVersion', '0.1.0');
    
    const { arch, libc } = systemInfo;
    return `https://github.com/${serverRepo}/releases/download/v${serverVersion}/server-linux-${arch}-${libc}-${serverVersion}.tar.gz`;
}

export async function downloadServer(
    url: string,
    destPath: string,
    logger: Log
): Promise<void> {
    logger.trace(`Downloading server from ${url}`);
    
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Follow redirect
                if (response.headers.location) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadServer(response.headers.location, destPath, logger)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                reject(new Error(`Failed to download server: HTTP ${response.statusCode}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                logger.trace(`Server downloaded to ${destPath}`);
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

export async function getOrDownloadServer(
    conn: SSHConnection,
    logger: Log
): Promise<string> {
    const systemInfo = await detectRemoteSystem(conn, logger);
    const downloadUrl = getServerDownloadUrl(systemInfo);
    const cachedServerPath = await tryDownloadServer(downloadUrl, logger);
    
    if (!cachedServerPath) {
        throw new Error('Failed to download server from GitHub releases');
    }
    
    return cachedServerPath;
}

async function tryDownloadServer(downloadUrl: string, logger: Log): Promise<string | null> {
    // Create cache directory
    const cacheDir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.uplink', 'servers');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    
    // Generate cache filename based on URL hash
    const urlHash = crypto.createHash('sha256').update(downloadUrl).digest('hex').substring(0, 16);
    const cachedServerPath = path.join(cacheDir, `server-${urlHash}.tar.gz`);
    
    // Check if already cached
    try {
        await fs.promises.access(cachedServerPath);
        logger.trace(`Using cached server from ${cachedServerPath}`);
        return cachedServerPath;
    } catch {
        // Not cached, try to download
        try {
            logger.trace(`Downloading server from ${downloadUrl}`);
            await downloadServer(downloadUrl, cachedServerPath, logger);
            return cachedServerPath;
        } catch (error) {
            logger.trace(`Download failed: ${error}`);
            return null;
        }
    }
}
