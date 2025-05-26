// Node.js script untuk menghasilkan alamat Xion dummy dan mengirim token

// Install dependencies: npm install @cosmjs/stargate @cosmjs/proto-signing bech32 dotenv

require('dotenv').config();
const fs = require('fs');
const bech32 = require('bech32'); // Library untuk enkripsi Bech32
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');
const crypto = require('crypto');

async function main() {
    // Memuat mnemonic pengirim dari file .env
    const mnemonic = process.env.MNEMONIC;
    if (!mnemonic) {
        console.error("Silakan atur variabel MNEMONIC di file .env Anda");
        process.exit(1);
    }

    // Generate 10 alamat Xion dummy (20-byte acak, dienkode dalam Bech32 dengan prefix 'xion')
    const prefix = 'xion';
    const dummyAddresses = [];
    for (let i = 0; i < 10; i++) {
        // Buat 20 byte acak
        const randomBytes = crypto.randomBytes(20);
        // Konversi menjadi kata 5-bit dan encode dengan prefix 'xion'
        const words = bech32.toWords(randomBytes);
        const address = bech32.encode(prefix, words);
        dummyAddresses.push(address);
    }

    // Simpan alamat-alamat dummy ke wallet.txt (satu per baris)
    fs.writeFileSync('wallet.txt', dummyAddresses.join('\n'));
    console.log("Alamat dummy disimpan ke wallet.txt");

    // Buat wallet dari mnemonic (prefix 'xion' sesuai jaringan Xion)
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: prefix });
    const accounts = await wallet.getAccounts();
    if (accounts.length === 0) {
        console.error("Gagal menurunkan akun dari mnemonic yang diberikan.");
        process.exit(1);
    }
    // Gunakan akun pertama sebagai alamat pengirim
    const senderAddress = accounts[0].address;
    console.log("Alamat pengirim:", senderAddress);

    // Koneksi ke RPC testnet Xion
    const rpcEndpoint = 'https://rpc.testnet.xion.org:443';
    console.log("Menghubung ke RPC Xion testnet:", rpcEndpoint);
    const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet);
    console.log("Berhasil terhubung ke Xion testnet");

    // Definisikan jumlah yang dikirim: 0.001 XION (1 XION = 1e6 uxion)
    const sendAmount = {
        denom: 'uxion',
        amount: '1000', // 0.001 XION = 1000 uxion
    };

    // Definisikan fee untuk transaksi (sesuaikan jika diperlukan)
    const fee = {
        amount: [
            { denom: 'uxion', amount: '200' }, // contoh fee: 200 uxion
        ],
        gas: '200000', // batas gas
    };

    // Kirim 0.001 XION ke setiap alamat dummy dan tampilkan hasil
    for (const recipient of dummyAddresses) {
        try {
            console.log(`Mengirim 0.001 XION ke ${recipient}...`);
            const result = await client.sendTokens(senderAddress, recipient, [sendAmount], fee, "");
            if (result.code === 0) {
                console.log(`✅ Berhasil: tx hash = ${result.transactionHash}`);
            } else {
                console.log(`❌ Gagal (kode ${result.code}): ${result.rawLog}`);
            }
        } catch (error) {
            console.error(`❌ Terjadi kesalahan saat mengirim ke ${recipient}:`, error);
        }
    }
}

main().catch(error => {
    console.error("Error tak terduga:", error);
});
