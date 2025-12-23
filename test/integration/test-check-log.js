const NativeSSH = require('./uplink-vscode-extention/uplink-ssh.darwin-arm64.node');

async function checkLog() {
    const sessionId = await NativeSSH.sshConnect(
        'dev-dsk-rishiad-1c-46b62fac.ap-northeast-1.amazon.com',
        22,
        'rishiad',
        process.env.HOME + '/.ssh/id_ecdsa',
        process.env.HOME + '/.ssh/id_ecdsa-cert.pub'
    );
    
    console.log('Connected, session:', sessionId);
    
    const logContent = await NativeSSH.sshExec(sessionId, 'cat ~/.kiro-server/.ff5b0b54a4bf5780b759a0cf91b16350f8f1fd95.log 2>&1 || echo "Log not found"');
    console.log('Log content:\n', logContent);
    
    await NativeSSH.sshDisconnect(sessionId);
}

checkLog().catch(console.error);
