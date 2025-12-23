import { EventEmitter } from 'events';
import * as NativeSSH from './native/ssh';
import Log from './common/logger';

export interface NativeSSHConfig {
    host: string;
    port: number;
    username: string;
    keyPath: string;
    certPath?: string;
}

export interface SSHTunnelConfig {
    name?: string;
    localPort?: number;
    remoteAddr?: string;
    remotePort?: number;
    remoteSocketPath?: string;
    socks?: boolean;
}

export class NativeSSHConnection extends EventEmitter {
    private sessionId: number | null = null;
    private config: NativeSSHConfig;
    private logger: Log;
    private tunnels: Map<string, { localPort: number }> = new Map();

    constructor(config: NativeSSHConfig, logger: Log) {
        super();
        this.config = config;
        this.logger = logger;
    }

    async connect(): Promise<NativeSSHConnection> {
        if (this.sessionId !== null) {
            return this;
        }

        this.logger.trace(`Native SSH connecting to ${this.config.host}:${this.config.port}`);
        
        this.sessionId = await NativeSSH.connect(
            this.config.host,
            this.config.port,
            this.config.username,
            this.config.keyPath,
            this.config.certPath
        );

        this.logger.trace(`Native SSH connected, session ID: ${this.sessionId}`);
        return this;
    }

    async exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
        await this.connect();
        
        if (this.sessionId === null) {
            throw new Error('Not connected');
        }

        const output = await NativeSSH.exec(this.sessionId, cmd);
        return { stdout: output, stderr: '' };
    }

    async addTunnel(config: SSHTunnelConfig): Promise<SSHTunnelConfig & { localPort: number }> {
        await this.connect();

        if (this.sessionId === null) {
            throw new Error('Not connected');
        }

        const name = config.name || `${config.remoteAddr}:${config.remotePort}`;
        
        if (this.tunnels.has(name)) {
            const existing = this.tunnels.get(name)!;
            return { ...config, localPort: existing.localPort };
        }

        if (config.socks) {
            throw new Error('SOCKS tunnels not supported in native SSH connection');
        }

        const localPort = await NativeSSH.forwardPort(
            this.sessionId,
            config.localPort || 0,
            config.remoteAddr || '127.0.0.1',
            config.remotePort || 0
        );

        this.tunnels.set(name, { localPort });
        this.logger.trace(`Native SSH tunnel created: ${name} -> localhost:${localPort}`);

        return { ...config, localPort };
    }

    closeTunnel(name?: string): Promise<void> {
        if (name) {
            this.tunnels.delete(name);
        } else {
            this.tunnels.clear();
        }
        return Promise.resolve();
    }

    async close(): Promise<void> {
        if (this.sessionId !== null) {
            await NativeSSH.disconnect(this.sessionId);
            this.sessionId = null;
            this.tunnels.clear();
        }
    }

    async uploadFile(localPath: string, remotePath: string): Promise<void> {
        await this.connect();

        if (this.sessionId === null) {
            throw new Error('Not connected');
        }

        await NativeSSH.uploadFile(this.sessionId, localPath, remotePath);
    }
}
