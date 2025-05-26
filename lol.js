// Script gabungan: generate 10 alamat dummy Xion dan kirim 0.001 XION dari mnemonic di .env

require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { toBech32 } = require('@cosmjs/encoding');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningStargateClient } = require('@cosmjs/stargate');

const RPC_ENDPOINT = "https://xion-testnet-rpc.polkachu.com";
const PREFIX = "xion";
const AMOUNT_TO_SEND = "1000"; // 0.001 XION = 1000 uxion

const amount = {
  denom: "uxion",
  amount: AMOUNT_TO_SEND,
};

const fee = {
  amount: [{ denom: "uxion", amount: "200" }],
  gas: "200000",
};

function generateXionAddress() {
  const randomBytes = crypto.randomBytes(20); // 20-byte address
  return toBech32(PREFIX, randomBytes);
}

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error("MNEMONIC belum diset di .env");
    return;
  }

  // Generate 10 alamat dummy dan simpan ke wallet.txt
  const dummyAddresses = Array.from({ length: 10 }, generateXionAddress);
  fs.writeFileSync('wallet.txt', dummyAddresses.join('\n'));
  console.log("Generated 10 dummy Xion addresses to wallet.txt");

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  const senderAddress = account.address;
  console.log("Sender:", senderAddress);

  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet);

  for (let i = 0; i < dummyAddresses.length; i++) {
    const to = dummyAddresses[i];
    try {
      const result = await client.sendTokens(senderAddress, to, [amount], fee, `Test tx ${i + 1}`);
      if (result.code === 0) {
        console.log(`Tx ${i + 1}: ${senderAddress} -> ${to} | Success | TX Hash: ${result.transactionHash}`);
      } else {
        console.error(`Tx ${i + 1}: Gagal | Code: ${result.code} | Log: ${result.rawLog}`);
      }
    } catch (err) {
      console.error(`Tx ${i + 1} Error ke ${to}:`, err.message);
    }
  }
}

main();
