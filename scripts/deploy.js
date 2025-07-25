const hre = require("hardhat");
require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');

const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const sendTelegramMessage = (msg) => {
    telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg)
        .catch(err => console.error('Telegram error:', err));
};

async function main() {
    const addressProvider = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"; // Aave V3 Sepolia AddressProvider
    
    sendTelegramMessage("🏗 Starting Flash Arbitrage contract deployment...");
    
    // Get deployment info
    const [deployer] = await hre.ethers.getSigners();
    const deployerBalance = await hre.ethers.provider.getBalance(deployer.address);
    
    console.log("Deploying with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(deployerBalance), "ETH");
    
    if (deployerBalance < hre.ethers.parseEther("0.01")) {
        throw new Error("Insufficient ETH balance for deployment");
    }
    
    // Deploy contract
    const FlashArbitrage = await hre.ethers.getContractFactory("FlashArbitrage");
    console.log("Deploying FlashArbitrage contract...");
    
    const contract = await FlashArbitrage.deploy(addressProvider);
    await contract.waitForDeployment();
    
    const contractAddress = await contract.getAddress();
    
    // Verify deployment
    const deployedAddressProvider = await contract.ADDRESSES_PROVIDER();
    const deployedPool = await contract.POOL();
    const owner = await contract.owner();
    
    console.log("\n✅ Deployment successful!");
    console.log("Contract address:", contractAddress);
    console.log("Owner:", owner);
    console.log("Address Provider:", deployedAddressProvider);
    console.log("Pool:", deployedPool);
    
    const successMsg = `✅ FlashArbitrage deployed successfully!\n` +
                      `📍 Contract: ${contractAddress}\n` +
                      `👤 Owner: ${owner}\n` +
                      `🏦 Pool: ${deployedPool}`;
    sendTelegramMessage(successMsg);
    
    const envMsg = `📝 Update your .env file:\nFLASH_ARBITRAGE_CONTRACT=${contractAddress}`;
    console.log(`\n${envMsg}`);
    sendTelegramMessage(envMsg);
    
    // Verify contract on Etherscan (optional)
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("\n🔍 Verifying contract on Etherscan...");
        try {
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: [addressProvider],
            });
            sendTelegramMessage("✅ Contract verified on Etherscan");
        } catch (error) {
            console.log("Verification failed:", error.message);
            sendTelegramMessage("⚠️ Contract verification failed");
        }
    }
}

main().catch((error) => {
    const errorMsg = `⚠️ Deployment failed: ${error.message}`;
    console.error(errorMsg);
    sendTelegramMessage(errorMsg);
    process.exit(1);
});