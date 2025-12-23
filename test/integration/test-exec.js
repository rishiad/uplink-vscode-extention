const { sshExecCommand } = require('./uplink-ssh.darwin-arm64.node');

async function test() {
    try {
        console.log('Testing SSH exec with certificate...');
        const result = await sshExecCommand(
            'dev-dsk-rishiad-1c-46b62fac.ap-northeast-1.amazon.com',
            22,
            'rishiad',
            '/Users/rishiad/.ssh/id_ecdsa',
            '/Users/rishiad/.ssh/id_ecdsa-cert.pub',
            'echo "Hello from native SSH!"'
        );
        console.log('✓ Output:', result);
    } catch (error) {
        console.error('✗ Error:', error.message);
    }
}

test();
