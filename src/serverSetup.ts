import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Log from './common/logger';
import { getVSCodeServerConfig } from './serverConfig';
import SSHConnection from './ssh/sshConnection';

export interface ServerInstallOptions {
    id: string;
    quality: string;
    commit: string;
    version: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverArchivePath: string;
}

export interface ServerInstallResult {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: any;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

export async function installCodeServer(
    conn: SSHConnection,
    serverArchivePath: string | undefined,
    extensionIds: string[],
    envVariables: string[],
    platform: string | undefined,
    useSocketPath: boolean,
    logger: Log
): Promise<ServerInstallResult> {
    const scriptId = crypto.randomBytes(12).toString('hex');
    const vscodeServerConfig = await getVSCodeServerConfig();

    if (!serverArchivePath) {
        throw new ServerInstallError('remote.SSH.sidecarArchivePath must be set for local sidecar installs');
    }

    const localArchivePath = path.resolve(serverArchivePath);
    try {
        await fs.promises.access(localArchivePath);
    } catch (error) {
        throw new ServerInstallError(`Sidecar archive not found at ${localArchivePath}`);
    }

    const detectedPlatform = platform || await detectRemotePlatform(conn, logger);
    if (detectedPlatform !== 'linux') {
        throw new ServerInstallError(`Only Linux remotes are supported for the MVP (detected: ${detectedPlatform})`);
    }

    const remoteHome = await resolveRemoteHomeDir(conn);
    const serverDir = `${remoteHome}/${vscodeServerConfig.serverDataFolderName}/bin/${vscodeServerConfig.commit}`;
    const serverScript = `${serverDir}/bin/${vscodeServerConfig.serverApplicationName}`;
    const remoteArchivePath = `${serverDir}/server.tar.gz`;

    const localArchiveSize = (await fs.promises.stat(localArchivePath)).size;
    const serverInstalled = await remoteFileExists(conn, serverScript);
    if (!serverInstalled) {
        await conn.exec(`mkdir -p ${shellEscape(serverDir)}`);
        logger.trace(`Uploading sidecar archive to ${remoteArchivePath}`);
        await conn.exec(`rm -f ${shellEscape(remoteArchivePath)}`);
        await conn.uploadFile(localArchivePath, remoteArchivePath);
        await verifyRemoteArchiveSize(conn, localArchivePath, remoteArchivePath, localArchiveSize, logger);
    }

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: vscodeServerConfig.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverArchivePath: remoteArchivePath,
    };

    const installServerScript = generateBashInstallScript(installOptions);

    logger.trace('Server install command:', installServerScript);

    const commandOutput = await conn.exec(`bash -c '${installServerScript.replace(/'/g, `'\\''`)}'`);

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError('Failed parsing install script output');
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError('Server install script returned non-zero exit status');
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

async function detectRemotePlatform(conn: SSHConnection, logger: Log): Promise<string> {
    const result = await conn.exec('uname -s');
    if (result.stdout.includes('Linux')) {
        return 'linux';
    }
    logger.trace('Remote platform detection output:', result);
    return 'unknown';
}

async function resolveRemoteHomeDir(conn: SSHConnection): Promise<string> {
    const result = await conn.exec('printf %s "$HOME"');
    const homeDir = result.stdout.trim();
    if (!homeDir) {
        throw new ServerInstallError('Unable to resolve remote home directory');
    }
    return homeDir;
}

async function remoteFileExists(conn: SSHConnection, remotePath: string): Promise<boolean> {
    const result = await conn.exec(`if [ -f ${shellEscape(remotePath)} ]; then echo yes; fi`);
    return result.stdout.trim() === 'yes';
}

async function getRemoteFileSize(conn: SSHConnection, remotePath: string): Promise<number | undefined> {
    const result = await conn.exec(`if [ -f ${shellEscape(remotePath)} ]; then wc -c < ${shellEscape(remotePath)}; fi`);
    const size = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(size) ? size : undefined;
}

async function verifyRemoteArchiveSize(
    conn: SSHConnection,
    localArchivePath: string,
    remoteArchivePath: string,
    localArchiveSize: number,
    logger: Log
): Promise<void> {
    const remoteSize = await getRemoteFileSize(conn, remoteArchivePath);
    if (remoteSize === localArchiveSize) {
        logger.trace(`Sidecar archive size verified (${localArchiveSize} bytes).`);
        return;
    }

    logger.trace(
        `Sidecar archive size mismatch (local ${localArchiveSize} bytes, remote ${remoteSize ?? 'missing'}). Retrying upload.`
    );
    await conn.exec(`rm -f ${shellEscape(remoteArchivePath)}`);
    await conn.uploadFile(localArchivePath, remoteArchivePath);

    const retrySize = await getRemoteFileSize(conn, remoteArchivePath);
    if (retrySize !== localArchiveSize) {
        throw new ServerInstallError(
            `Sidecar archive upload incomplete (local ${localArchiveSize} bytes, remote ${retrySize ?? 'missing'}).`
        );
    }
    logger.trace(`Sidecar archive size verified after retry (${localArchiveSize} bytes).`);
}

function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function generateBashInstallScript({ id, quality, version, commit, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverArchivePath }: ServerInstallOptions) {
    const extensions = extensionIds.map(extId => `--install-extension ${extId}`).join(' ');
    return `
# Server installation script

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="${version}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path=\"$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}\"` : '--port=0'}"
SERVER_DATA_DIR="$HOME/${serverDataFolderName}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCHIVE_PATH="${serverArchivePath}"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
    echo "${id}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `echo "${envVar}==$${envVar}=="`).join('\n')}
    echo "${id}: end"
    exit 0
}

# Check if platform is supported
KERNEL="$(uname -s)"
case $KERNEL in
    Linux)
        PLATFORM="linux"
        ;;
    *)
        echo "Error platform not supported: $KERNEL"
        print_install_results_and_exit 1
        ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    *)
        echo "Error architecture not supported: $ARCH"
        print_install_results_and_exit 1
        ;;
esac

# https://www.freedesktop.org/software/systemd/man/os-release.html
OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
if [[ -z $OS_RELEASE_ID ]]; then
    OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^ID=//gi' | sed 's/"//g')"
    if [[ -z $OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="unknown"
    fi
fi

# Create installation folder
if [[ ! -d $SERVER_DIR ]]; then
    mkdir -p $SERVER_DIR
    if (( $? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

# Check if server script is already installed
if [[ ! -f $SERVER_SCRIPT ]]; then
    if [[ ! -f $SERVER_ARCHIVE_PATH ]]; then
        echo "Error sidecar archive not found at $SERVER_ARCHIVE_PATH"
        print_install_results_and_exit 1
    fi

    if [[ -d $SERVER_DIR ]]; then
        find "$SERVER_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$SERVER_ARCHIVE_PATH")" -exec rm -rf {} +
    fi

    pushd $SERVER_DIR > /dev/null
    tar -xf "$SERVER_ARCHIVE_PATH" --strip-components 1
    if (( $? > 0 )); then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi

    if [[ ! -f $SERVER_SCRIPT ]]; then
        if [[ "$SERVER_APP_NAME" != "openvscode-server" && -f "$SERVER_DIR/bin/openvscode-server" ]]; then
            SERVER_APP_NAME="openvscode-server"
            SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
        elif [[ "$SERVER_APP_NAME" != "code-server" && -f "$SERVER_DIR/bin/code-server" ]]; then
            SERVER_APP_NAME="code-server"
            SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
        else
            echo "Error server contents are corrupted"
            print_install_results_and_exit 1
        fi
    fi

    rm -f "$SERVER_ARCHIVE_PATH"
    popd > /dev/null
else
    echo "Server script already installed in $SERVER_SCRIPT"
fi

# Try to find if server is already running
if [[ -f $SERVER_PIDFILE ]]; then
    SERVER_PID="$(cat $SERVER_PIDFILE)"
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
else
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z $SERVER_RUNNING_PROCESS ]]; then
    if [[ -f $SERVER_LOGFILE ]]; then
        rm $SERVER_LOGFILE
    fi
    if [[ -f $SERVER_TOKENFILE ]]; then
        rm $SERVER_TOKENFILE
    fi

    touch $SERVER_TOKENFILE
    chmod 600 $SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

    $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
    echo $! > $SERVER_PIDFILE
else
    echo "Server script is already running $SERVER_SCRIPT"
fi

if [[ -f $SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
    echo "Error server token file not found $SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
    for i in {1..5}; do
        LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n $LISTENING_ON ]]; then
            break
        fi
        sleep 0.5
    done

    if [[ -z $LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        print_install_results_and_exit 1
    fi
else
    echo "Error server log file not found $SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
`;
}
