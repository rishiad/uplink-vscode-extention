const { sshConnect, sshExec, sshForwardPort, sshDisconnect } = require('./uplink-ssh.darwin-arm64.node');

async function test() {
    let sessionId;
    try {
        console.log('1. Connecting with certificate...');
        sessionId = await sshConnect(
            'dev-dsk-rishiad-1c-46b62fac.ap-northeast-1.amazon.com',
            22,
            'rishiad',
            '/Users/rishiad/.ssh/id_ecdsa',
            '/Users/rishiad/.ssh/id_ecdsa-cert.pub'
        );
        console.log('✓ Connected, session ID:', sessionId);

        console.log('\n2. Executing command...');
        const output = await sshExec(sessionId, 'echo "Hello from session!"');
        console.log('✓ Output:', output.trim());

        console.log('\n3. Setting up port forward (local 0 -> remote 127.0.0.1:22)...');
        const localPort = await sshForwardPort(sessionId, 0, '127.0.0.1', 22);
        console.log('✓ Forwarding on local port:', localPort);

        console.log('\n4. Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('\n5. Disconnecting...');
        await sshDisconnect(sessionId);
        console.log('✓ Disconnected');

    } catch (error) {
        console.error('✗ Error:', error.message);
        if (sessionId !== undefined) {
            try {
                await sshDisconnect(sessionId);
            } catch (e) {}
        }
    }
}

test();
