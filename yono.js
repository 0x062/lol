const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate"); // Hapus 'coin' dari sini
const { calculateFee, GasPrice, coin } = require("@cosmjs/stargate");   // Tambahkan 'coin' di sini
const crypto = require('crypto'); // Untuk membuat salt acak

// --- PASTE KODE LAIN ANDA DI SINI (logger, bufferReport, flushReport, dll.) ---
// Contoh logger (jika belum ada)
const logger = {
  info: (msg) => console.log(`[✓] ${msg}`),
  warn: (msg) => console.log(`[⚠] ${msg}`),
  error: (msg) => console.log(`[✗] ${msg}`),
  success: (msg) => console.log(`[✅] ${msg}`),
  loading: (msg) => console.log(`[⟳] ${msg}`),
};
let reportBuffer = [];
function bufferReport(text) { reportBuffer.push(text); }
async function flushReport() { 
    console.log("--- TELEGRAM REPORT ---"); 
    console.log(reportBuffer.join("\n")); 
    console.log("-----------------------");
    reportBuffer = []; 
    // Ganti dengan fungsi sendReport asli Anda:
    // try { await sendReport(reportBuffer.join("\n")); } catch (err) { logger.error(`Telegram report failed: ${err.message}`); } reportBuffer = [];
}
function timelog() { return new Date().toISOString(); }
// --------------------------------------------------------------------------


async function sendToXionBridge(mnemonic, xionRpcEndpoint, bridgeContractAddress, messageTemplate, fundsToSend = []) {
    const XION_PREFIX = "xion";
    const GAS_PRICE_STR = "0.025uxion"; 
    const GAS_LIMIT = 700000; 

    if (!bridgeContractAddress || !bridgeContractAddress.startsWith("xion1")) {
        logger.error("Alamat Kontrak Jembatan Xion tidak valid!");
        bufferReport("❌ Gagal: Alamat Kontrak Jembatan Xion tidak valid!");
        await flushReport();
        return;
    }

    logger.loading(`Preparing Xion wallet...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: XION_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderXionAddress = firstAccount.address;

    logger.loading(`Connecting to Xion Testnet (${xionRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(
        xionRpcEndpoint,
        wallet
    );
    logger.info(`Xion Wallet Address: ${senderXionAddress}`);

    let payload = JSON.parse(JSON.stringify(messageTemplate));

    const fifteenMinutesInNs = 15 * 60 * 1000 * 1_000_000;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    payload.send.timeout_timestamp = (currentTimestampNs + BigInt(fifteenMinutesInNs)).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    logger.loading(`Sending message to ${bridgeContractAddress}:`);
    console.log(JSON.stringify(payload.send, null, 2)); 

    const funds = [ coin("10000", "uxion") ];
    const fee = calculateFee(GAS_LIMIT, GasPrice.fromString(GAS_PRICE_STR));

    try {
        const result = await client.execute(
            senderXionAddress,
            bridgeContractAddress,
            payload, 
            fee, 
            "Xion to Holesky via JS Partner v4",
            funds
        );

        logger.success(`Transaction sent on Xion! Hash: ${result.transactionHash}`);
        bufferReport(`✅ Initiated Xion -> Holesky | Xion Tx: \`${result.transactionHash.substring(0, 10)}...\``);

    } catch (err) {
        logger.error(`Xion transaction failed: ${err.message}`);
        bufferReport(`❌ Failed Xion -> Holesky: ${err.message}`);
    }

    await flushReport();
}

// --- Fungsi untuk Menjalankan ---
async function runXionTransfer() {
    require('dotenv').config(); // Pastikan .env dimuat
    
    const xionMnemonic = process.env.XION_MNEMONIC; 
    const xionRpc = "https://rpc.xion-testnet-2.burnt.com"; // <== PERIKSA KEMBALI RPC INI!
    
    // +++ ALAMAT KONTRAK DARI JSON KEDUA ANDA +++
    const bridgeAddr = "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; 
    
    // +++ TEMPLATE JSON DARI JSON PERTAMA ANDA (SUDAH DIISI) +++
    const xionMessageTemplate = {
      "send": {
        "channel_id": 1,
        "timeout_height": "0",
        "timeout_timestamp": "1748601863261000000", // Akan di-update otomatis
        "salt": "0x729eba29958daf8b86024357677479b6ced616e973f0a7c6b287511b581a602a", // Akan di-update otomatis
        "instruction": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf800000000000000000000000000000000000000000000000000000000000000000000000000000000000000057578696f6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000458494f4e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000478696f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001407D878ab885453DcB2baa987E6761C86b5f45F27000000000000000000000000"
      }
    };

    if (!xionMnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan di .env!");
        return;
    }
    if (!xionRpc) {
        logger.error("XION_RPC tidak valid!");
        return;
    }

    await sendToXionBridge(xionMnemonic, xionRpc, bridgeAddr, xionMessageTemplate);
}

// Panggil fungsi utama untuk memulai
runXionTransfer().catch(console.error);
