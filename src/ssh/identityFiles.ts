import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ParsedKey } from 'ssh2-streams';
import * as ssh2 from 'ssh2';
import { untildify, exists as fileExists } from '../common/files';
import Log from '../common/logger';
import { loadSSHKeyInfo, isCertificateFile } from '../native/ssh';

const homeDir = os.homedir();
const PATH_SSH_CLIENT_ID_DSA = path.join(homeDir, '.ssh', '/id_dsa');
const PATH_SSH_CLIENT_ID_ECDSA = path.join(homeDir, '.ssh', '/id_ecdsa');
const PATH_SSH_CLIENT_ID_RSA = path.join(homeDir, '.ssh', '/id_rsa');
const PATH_SSH_CLIENT_ID_ED25519 = path.join(homeDir, '.ssh', '/id_ed25519');
const PATH_SSH_CLIENT_ID_XMSS = path.join(homeDir, '.ssh', '/id_xmss');
const PATH_SSH_CLIENT_ID_ECDSA_SK = path.join(homeDir, '.ssh', '/id_ecdsa_sk');
const PATH_SSH_CLIENT_ID_ED25519_SK = path.join(homeDir, '.ssh', '/id_ed25519_sk');

const DEFAULT_IDENTITY_FILES: string[] = [
    PATH_SSH_CLIENT_ID_RSA,
    PATH_SSH_CLIENT_ID_ECDSA,
    PATH_SSH_CLIENT_ID_ECDSA_SK,
    PATH_SSH_CLIENT_ID_ED25519,
    PATH_SSH_CLIENT_ID_ED25519_SK,
    PATH_SSH_CLIENT_ID_XMSS,
    PATH_SSH_CLIENT_ID_DSA,
];

export interface SSHKey {
    filename: string;
    parsedKey: ParsedKey;
    fingerprint: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
    isCertificate?: boolean;
}

// From https://github.com/openssh/openssh-portable/blob/acb2059febaddd71ee06c2ebf63dcf211d9ab9f2/sshconnect2.c#L1689-L1690
export async function gatherIdentityFiles(identityFiles: string[], sshAgentSock: string | undefined, identitiesOnly: boolean, logger: Log) {
    identityFiles = identityFiles.map(untildify).map(i => i.replace(/\.pub$/, ''));
    if (identityFiles.length === 0) {
        identityFiles.push(...DEFAULT_IDENTITY_FILES);
    }

    const identityFileContentsResult = await Promise.allSettled(identityFiles.map(async keyPath => {
        // Only use private key files, skip certificates and public keys for now
        if (await fileExists(keyPath)) {
            return { keyPath: keyPath, content: await fs.promises.readFile(keyPath) };
        }
        throw new Error(`Key file not found: ${keyPath}`);
    }));
    
    const fileKeys: SSHKey[] = [];
    identityFileContentsResult.forEach((result, i) => {
        if (result.status === 'rejected') {
            return;
        }

        const { keyPath, content } = result.value;
        
        try {
            // Try native Rust module for key validation (optional)
            try {
                const keyInfo = loadSSHKeyInfo(keyPath);
                logger.trace(`Native key info for ${keyPath}: ${keyInfo}`);
            } catch (nativeError) {
                logger.trace(`Native module couldn't load ${keyPath}, trying ssh2 fallback`);
            }
            
            // Use ssh2 for actual parsing
            const parsedResult = ssh2.utils.parseKey(content);
            if (parsedResult instanceof Error || !parsedResult) {
                logger.error(`Error while parsing SSH private key ${keyPath}:`, parsedResult);
                return;
            }

            const parsedKey = Array.isArray(parsedResult) ? parsedResult[0] : parsedResult;
            const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');

            fileKeys.push({
                filename: keyPath,
                parsedKey,
                fingerprint,
                isCertificate: false,
                isPrivate: true,
                agentSupport: false
            });
        } catch (error) {
            logger.error(`Failed to parse key ${keyPath}:`, error);
        }
    });

    let sshAgentParsedKeys: ParsedKey[] = [];
    try {
        if (!sshAgentSock) {
            throw new Error(`SSH_AUTH_SOCK environment variable not defined`);
        }

        sshAgentParsedKeys = await new Promise<ParsedKey[]>((resolve, reject) => {
            const sshAgent = new ssh2.OpenSSHAgent(sshAgentSock);
            sshAgent.getIdentities((err, publicKeys) => {
                if (err) {
                    reject(err);
                } else {
                    resolve((publicKeys || []) as unknown as ParsedKey[]);
                }
            });
        });
        logger.trace(`Got ${sshAgentParsedKeys.length} keys from SSH agent`);
    } catch (e) {
        logger.error(`Couldn't get identities from OpenSSH agent`, e);
    }

    const sshAgentKeys: SSHKey[] = sshAgentParsedKeys.map(parsedKey => {
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
        return {
            filename: parsedKey.comment,
            parsedKey,
            fingerprint,
            agentSupport: true
        };
    });

    const agentKeys: SSHKey[] = [];
    const preferredIdentityKeys: SSHKey[] = [];
    for (const agentKey of sshAgentKeys) {
        const foundIdx = fileKeys.findIndex(k => {
            // Skip certificates in matching since they don't have parsed keys
            if (k.isCertificate) {
                return false;
            }
            return agentKey.parsedKey.type === k.parsedKey.type && agentKey.fingerprint === k.fingerprint;
        });
        if (foundIdx >= 0) {
            preferredIdentityKeys.push({ ...fileKeys[foundIdx], agentSupport: true });
            fileKeys.splice(foundIdx, 1);
        } else if (!identitiesOnly) {
            agentKeys.push(agentKey);
        }
    }
    preferredIdentityKeys.push(...agentKeys);
    preferredIdentityKeys.push(...fileKeys);

    // Only use regular keys for now
    const regularKeys = preferredIdentityKeys.filter(k => !k.isCertificate);
    const sortedKeys = [...regularKeys];

    logger.trace(`Identity keys:`, sortedKeys.length ? sortedKeys.map(k => {
        const type = k.parsedKey?.type || 'unknown';
        return `${k.filename} ${type} ${k.fingerprint}`;
    }).join('\n') : 'None');

    return sortedKeys;
}
