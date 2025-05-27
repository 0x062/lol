const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient, coin } = require("@cosmjs/cosmwasm-stargate");
const { calculateFee, GasPrice } = require("@cosmjs/stargate");
const crypto = require('crypto');

// ... (logger, bufferReport, flushReport) ...

async function sendToXionBridge(mnemonic, xionRpcEndpoint, messageTemplate) {
    const XION_PREFIX = "xion";
    // +++ ALAMAT KONTRAK YANG BENAR! +++
    const BRIDGE_CONTRACT_ADDRESS = "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; 
    const GAS_PRICE_STR = "0.025uxion"; // Anda bisa sesuaikan ini nanti
    const GAS_LIMIT = 700000; // Sedikit lebih tinggi dari contoh Anda (654049)

    logger.loading(`Preparing Xion wallet...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: XION_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderXionAddress = firstAccount.address;

    logger.loading(`Connecting to Xion Testnet (${xionRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(
        xionRpcEndpoint,
        wallet
        // Kita akan set fee manual atau auto, jadi GasPrice di sini opsional
    );
    logger.info(`Xion Wallet Address: ${senderXionAddress}`);

    let payload = JSON.parse(JSON.stringify(messageTemplate));

    // Buat Timeout (15 menit dari sekarang)
    const fifteenMinutesInNs = 15 * 60 * 1000 * 1_000_000;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    payload.send.timeout_timestamp = (currentTimestampNs + BigInt(fifteenMinutesInNs)).toString();

    // Buat Salt
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    // (PENTING) Modifikasi 'instruction' jika perlu dibuat dinamis
    // Saat ini kita masih pakai 'instruction' dari template.

    logger.loading(`Sending message to ${BRIDGE_CONTRACT_ADDRESS}:`);
    console.log(JSON.stringify(payload, null, 2)); 

    // +++ TENTUKAN DANA YANG DIKIRIM (SESUAI CONTOH) +++
    const funds = [
        coin("10000", "uxion"), // <== Mengirim 0.01 XION seperti contoh Anda
    ];

    // +++ TENTUKAN FEE TRANSAKSI +++
    // Anda bisa pakai 'auto' atau hitung manual seperti ini:
    const fee = calculateFee(GAS_LIMIT, GasPrice.fromString(GAS_PRICE_STR));

    try {
        const result = await client.execute(
            senderXionAddress,
            BRIDGE_CONTRACT_ADDRESS,
            payload.send, // <== Kirim objek 'send', bukan {send: ...}
            fee, // <== Menggunakan fee yang dihitung (atau 'auto')
            "Xion to Holesky via JS Partner v3", // Memo
            funds    // <== Mengirim dana 0.01 XION
        );

        logger.success(`Transaction sent on Xion! Hash: ${result.transactionHash}`);
        bufferReport(`✅ Initiated Xion -> Holesky | Xion Tx: \`${result.transactionHash.substring(0, 10)}...\``);

    } catch (err) {
        logger.error(`Xion transaction failed: ${err.message}`);
        bufferReport(`❌ Failed Xion -> Holesky: ${err.message}`);
    }

    await flushReport();
}

// --- Cara Memanggilnya ---
async function runXionTransfer() {
    const xionMnemonic = process.env.XION_MNEMONIC; // Pastikan ada di .env
    const xionRpc = "https://testnet-rpc.xion-api.com"; // <== PERIKSA KEMBALI RPC INI!
    
    // +++ GUNAKAN JSON LENGKAP DARI ANDA SEBAGAI TEMPLATE +++
    const xionMessageTemplate = { "send": { /* ... ISI LENGKAP JSON 'send' ANDA DI SINI ... */ } }; 

    // Pastikan template diisi dengan benar
    if (!xionMessageTemplate.send || !xionMessageTemplate.send.instruction) {
         logger.error("Template JSON 'send' tidak lengkap!");
         return;
    }

    if (!xionMnemonic || !xionRpc) {
        logger.error("Konfigurasi Xion belum lengkap (XION_MNEMONIC, RPC)!");
        return;
    }

    await sendToXionBridge(xionMnemonic, xionRpc, xionMessageTemplate);
}

// Untuk menjalankan, panggil:
runXionTransfer();
