const { sshConnectWithKey } = require('./uplink-ssh.darwin-arm64.node');

async function test() {
    try {
        console.log('Testing native SSH connection with certificate...');
        const result = await sshConnectWithKey(
            'dev-dsk-rishiad-1c-46b62fac.ap-northeast-1.amazon.com',
            22,
            'rishiad',
            '/Users/rishiad/.ssh/id_ecdsa',
            '/Users/rishiad/.ssh/id_ecdsa-cert.pub'
        );
        console.log('✓ Success:', result);
    } catch (error) {
        console.error('✗ Error:', error.message);
    }
}

test();
