const { ethers } = require("ethers");
const TelegramBot = require('node-telegram-bot-api');
require("dotenv").config();

// Initialize Telegram bot
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const sendTelegramMessage = (msg) => {
    console.log(`[${new Date().toISOString()}] ${msg}`);
    telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg)
        .catch(err => console.error('Telegram error:', err));
};

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(
    `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`
);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Sepolia testnet addresses (verified for current testnet state)
const CONTRACTS = {
    // Aave V3 Sepolia
    AAVE_POOL: process.env.AAVE_POOL_ADDRESS,
    FLASH_ARBITRAGE: process.env.FLASH_ARBITRAGE_CONTRACT,
    
    // DEX Routers on Sepolia
    UNISWAP_V3_ROUTER: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    UNISWAP_V3_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    SUSHISWAP_ROUTER: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    
    // Tokens
    TOKENS: {
        DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
        WETH: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c",
        USDC: "0xda9d4f9b69ac6C22e444eD9aF0CfC043b7a7f53f"
    }
};

// Bot configuration
const BOT_CONFIG = {
    SCAN_INTERVAL: 60000, // 1 minute
    MIN_PROFIT_WEI: ethers.parseUnits("0.1", 18), // 0.1 DAI minimum profit
    MAX_GAS_PRICE: ethers.parseUnits("25", "gwei"),
    DEFAULT_AMOUNT: ethers.parseUnits("10", 18), // 10 DAI
    MIN_PRICE_DIFFERENCE: 50, // 0.5% minimum price difference (in basis points)
    MAX_SLIPPAGE: 200 // 2% maximum slippage (in basis points)
};

class ProductionArbitrageBot {
    constructor() {
        this.isRunning = false;
        this.contractBalances = {};
        this.gasHistory = [];
        this.profitHistory = [];
        
        // Initialize contract interfaces
        this.contracts = {
            aavePool: new ethers.Contract(
                CONTRACTS.AAVE_POOL,
                ["function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external"],
                wallet
            ),
            flashArbitrage: new ethers.Contract(
                CONTRACTS.FLASH_ARBITRAGE,
                [
                    "function fundContract(address token, uint256 amount) external",
                    "function withdrawToken(address token) external",
                    "event ArbitrageProfit(address indexed token, uint256 profit)",
                    "event ArbitrageFailure(string reason)"
                ],
                wallet
            ),
            uniswapQuoter: new ethers.Contract(
                CONTRACTS.UNISWAP_V3_QUOTER,
                [
                    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)"
                ],
                wallet
            ),
            sushiswapRouter: new ethers.Contract(
                CONTRACTS.SUSHISWAP_ROUTER,
                [
                    "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
                ],
                wallet
            ),
            dai: new ethers.Contract(
                CONTRACTS.TOKENS.DAI,
                [
                    "function balanceOf(address account) view returns (uint256)",
                    "function approve(address spender, uint256 amount) returns (bool)",
                    "function transfer(address to, uint256 amount) returns (bool)"
                ],
                wallet
            )
        };
    }

    async start() {
        if (this.isRunning) {
            sendTelegramMessage("⚠️ Bot is already running!");
            return;
        }

        this.isRunning = true;
        const startMsg = `🚀 Production Arbitrage Bot Started at ${new Date().toLocaleString()}`;
        sendTelegramMessage(startMsg);

        try {
            // Pre-flight checks
            await this.performStartupChecks();
            
            // Main loop
            while (this.isRunning) {
                try {
                    await this.executeTradingCycle();
                } catch (error) {
                    const errorMsg = `⚠️ Trading cycle error: ${error.message}`;
                    sendTelegramMessage(errorMsg);
                    console.error('Trading cycle error:', error);
                }
                
                // Wait before next cycle
                await new Promise(resolve => setTimeout(resolve, BOT_CONFIG.SCAN_INTERVAL));
            }
        } catch (error) {
            const fatalMsg = `💥 Fatal bot error: ${error.message}`;
            sendTelegramMessage(fatalMsg);
            console.error('Fatal error:', error);
        } finally {
            this.isRunning = false;
        }
    }

    async performStartupChecks() {
        sendTelegramMessage("🔍 Performing startup checks...");
        
        // Check wallet balance
        const ethBalance = await provider.getBalance(wallet.address);
        const ethFormatted = ethers.formatEther(ethBalance);
        
        if (ethBalance < ethers.parseEther("0.01")) {
            throw new Error(`Insufficient ETH balance: ${ethFormatted} ETH`);
        }
        
        // Check contract funding
        await this.ensureContractFunding();
        
        // Verify gas prices
        const gasPrice = await this.getCurrentGasPrice();
        
        sendTelegramMessage(
            `✅ Startup checks complete\\n` +
            `💰 Wallet: ${ethFormatted} ETH\\n` +
            `⛽ Gas: ${gasPrice.toFixed(2)} gwei`
        );
    }

    async ensureContractFunding() {
        const balance = await this.contracts.dai.balanceOf(CONTRACTS.FLASH_ARBITRAGE);
        const balanceFormatted = ethers.formatUnits(balance, 18);
        
        if (balance < ethers.parseUnits("5", 18)) {
            sendTelegramMessage(`💳 Contract needs funding. Current: ${balanceFormatted} DAI`);
            
            // Check if we have DAI to fund with
            const walletDaiBalance = await this.contracts.dai.balanceOf(wallet.address);
            if (walletDaiBalance < ethers.parseUnits("10", 18)) {
                throw new Error("Insufficient DAI in wallet for contract funding");
            }
            
            // Approve and fund contract
            const approveTx = await this.contracts.dai.approve(
                CONTRACTS.FLASH_ARBITRAGE,
                ethers.parseUnits("10", 18)
            );
            await approveTx.wait();
            
            const fundTx = await this.contracts.flashArbitrage.fundContract(
                CONTRACTS.TOKENS.DAI,
                ethers.parseUnits("10", 18)
            );
            await fundTx.wait();
            
            sendTelegramMessage("✅ Contract funded with 10 DAI");
        } else {
            sendTelegramMessage(`✅ Contract sufficiently funded: ${balanceFormatted} DAI`);
        }
    }

    async executeTradingCycle() {
        console.log(`\\n🔍 Scanning for opportunities at ${new Date().toLocaleTimeString()}`);
        
        // Check gas conditions
        const gasPrice = await this.getCurrentGasPrice();
        if (gasPrice > parseFloat(ethers.formatUnits(BOT_CONFIG.MAX_GAS_PRICE, "gwei"))) {
            console.log(`⛽ Gas too high: ${gasPrice.toFixed(2)} gwei`);
            return;
        }
        
        // Find arbitrage opportunities
        const opportunities = await this.scanForArbitrageOpportunities();
        if (opportunities.length === 0) {
            console.log("📭 No profitable opportunities found");
            return;
        }
        
        // Execute the most profitable opportunity
        const bestOpportunity = opportunities[0];
        sendTelegramMessage(
            `💡 Opportunity Found!\\n` +
            `Pair: ${bestOpportunity.tokenA}/${bestOpportunity.tokenB}\\n` +
            `Expected Profit: ${ethers.formatUnits(bestOpportunity.estimatedProfit, 18)} DAI\\n` +
            `Price Difference: ${bestOpportunity.priceDifference.toFixed(2)}%`
        );
        
        await this.executeArbitrage(bestOpportunity);
    }

    async scanForArbitrageOpportunities() {
        const opportunities = [];
        const amount = BOT_CONFIG.DEFAULT_AMOUNT;
        
        try {
            // Compare DAI/WETH prices between Uniswap and SushiSwap
            const [uniswapPrice, sushiPrice] = await Promise.all([
                this.getUniswapPrice(CONTRACTS.TOKENS.DAI, CONTRACTS.TOKENS.WETH, amount),
                this.getSushiPrice(CONTRACTS.TOKENS.DAI, CONTRACTS.TOKENS.WETH, amount)
            ]);
            
            if (uniswapPrice && sushiPrice) {
                const opportunity = this.analyzeOpportunity(
                    amount,
                    uniswapPrice,
                    sushiPrice,
                    CONTRACTS.TOKENS.DAI,
                    CONTRACTS.TOKENS.WETH
                );
                
                if (opportunity) {
                    opportunities.push(opportunity);
                }
            }
        } catch (error) {
            console.error('Error scanning opportunities:', error);
        }
        
        // Sort by profitability
        return opportunities.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
    }

    async getUniswapPrice(tokenIn, tokenOut, amountIn) {
        try {
            const quote = await this.contracts.uniswapQuoter.quoteExactInputSingle.staticCall(
                tokenIn,
                tokenOut,
                3000, // 0.3% fee tier
                amountIn,
                0
            );
            return { amount: quote, source: 'uniswap' };
        } catch (error) {
            console.error('Uniswap price error:', error.message);
            return null;
        }
    }

    async getSushiPrice(tokenIn, tokenOut, amountIn) {
        try {
            const amounts = await this.contracts.sushiswapRouter.getAmountsOut(
                amountIn,
                [tokenIn, tokenOut]
            );
            return { amount: amounts[1], source: 'sushiswap' };
        } catch (error) {
            console.error('SushiSwap price error:', error.message);
            return null;
        }
    }

    analyzeOpportunity(amount, price1, price2, tokenA, tokenB) {
        const amount1 = BigInt(price1.amount.toString());
        const amount2 = BigInt(price2.amount.toString());
        
        // Calculate price difference percentage
        const priceDiff = amount1 > amount2 ?
            Number((amount1 - amount2) * 10000n / amount1) :
            Number((amount2 - amount1) * 10000n / amount2);
        
        // Check if difference meets minimum threshold
        if (priceDiff < BOT_CONFIG.MIN_PRICE_DIFFERENCE) {
            return null;
        }
        
        // Determine trade direction
        const buyFromDex = amount1 > amount2 ? price2.source : price1.source;
        const sellToDex = amount1 > amount2 ? price1.source : price2.source;
        const buyPrice = amount1 > amount2 ? amount2 : amount1;
        const sellPrice = amount1 > amount2 ? amount1 : amount2;
        
        // Calculate estimated profit (accounting for fees)
        const flashLoanFee = amount * 9n / 10000n; // 0.09% Aave fee
        const estimatedProfit = sellPrice - buyPrice - flashLoanFee;
        
        if (estimatedProfit < BOT_CONFIG.MIN_PROFIT_WEI) {
            return null;
        }
        
        return {
            tokenA,
            tokenB,
            amount,
            buyFromDex,
            sellToDex,
            buyPrice,
            sellPrice,
            estimatedProfit,
            priceDifference: priceDiff / 100, // Convert to percentage
            gasEstimate: ethers.parseUnits("200000", "wei") // Rough gas estimate
        };
    }

    async executeArbitrage(opportunity) {
        try {
            sendTelegramMessage(`⚡ Executing arbitrage trade...`);
            
            // Prepare transaction parameters
            const params = this.encodeArbitrageParams(opportunity);
            
            // Execute flash loan
            const tx = await this.contracts.aavePool.flashLoanSimple(
                CONTRACTS.FLASH_ARBITRAGE,
                opportunity.tokenA,
                opportunity.amount,
                params,
                0,
                { gasLimit: 500000 }
            );
            
            sendTelegramMessage(
                `📝 Transaction sent: https://sepolia.etherscan.io/tx/${tx.hash}`
            );
            
            // Wait for confirmation
            const receipt = await tx.wait();
            
            // Parse results
            await this.parseTransactionResult(receipt);
            
        } catch (error) {
            const errorMsg = `❌ Arbitrage execution failed: ${error.message}`;
            sendTelegramMessage(errorMsg);
            console.error('Arbitrage execution error:', error);
        }
    }

    encodeArbitrageParams(opportunity) {
        // This is a simplified version - in production you'd need actual DEX interaction calldata
        const swapTargets = [
            opportunity.buyFromDex === 'uniswap' ? CONTRACTS.UNISWAP_V3_ROUTER : CONTRACTS.SUSHISWAP_ROUTER,
            opportunity.sellToDex === 'uniswap' ? CONTRACTS.UNISWAP_V3_ROUTER : CONTRACTS.SUSHISWAP_ROUTER
        ];
        
        // Mock swap data - replace with actual DEX calls
        const swapData = [
            "0x", // Buy swap calldata
            "0x"  // Sell swap calldata
        ];
        
        return ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address[]", "bytes[]"],
            [opportunity.estimatedProfit, swapTargets, swapData]
        );
    }

    async parseTransactionResult(receipt) {
        const iface = new ethers.Interface([
            "event ArbitrageProfit(address indexed token, uint256 profit)",
            "event ArbitrageFailure(string reason)"
        ]);
        
        let profit = null;
        let failure = null;
        
        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed) {
                    if (parsed.name === "ArbitrageProfit") {
                        profit = parsed.args.profit;
                    } else if (parsed.name === "ArbitrageFailure") {
                        failure = parsed.args.reason;
                    }
                }
            } catch (e) {
                // Not our event
            }
        }
        
        if (profit) {
            const profitFormatted = ethers.formatUnits(profit, 18);
            const successMsg = `✅ Arbitrage successful! Profit: ${profitFormatted} DAI`;
            sendTelegramMessage(successMsg);
            this.profitHistory.push({ timestamp: Date.now(), profit: profit });
        } else if (failure) {
            sendTelegramMessage(`⚠️ Arbitrage failed: ${failure}`);
        } else {
            sendTelegramMessage(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
        }
    }

    async getCurrentGasPrice() {
        try {
            const feeData = await provider.getFeeData();
            const gasPrice = parseFloat(ethers.formatUnits(feeData.gasPrice, "gwei"));
            
            this.gasHistory.push({ timestamp: Date.now(), gasPrice });
            
            // Keep only last 20 readings
            if (this.gasHistory.length > 20) {
                this.gasHistory = this.gasHistory.slice(-20);
            }
            
            return gasPrice;
        } catch (error) {
            console.error("Error getting gas price:", error);
            return 50; // Fallback gas price
        }
    }

    stop() {
        this.isRunning = false;
        sendTelegramMessage("🛑 Bot stopped");
    }

    // Health monitoring
    getStatus() {
        const avgGas = this.gasHistory.length > 0 ?
            this.gasHistory.reduce((sum, entry) => sum + entry.gasPrice, 0) / this.gasHistory.length : 0;
        
        const totalProfit = this.profitHistory.reduce((sum, entry) => sum + Number(entry.profit), 0);
        
        return {
            isRunning: this.isRunning,
            avgGasPrice: avgGas.toFixed(2),
            totalProfitWei: totalProfit,
            successfulTrades: this.profitHistory.length,
            uptime: Date.now() - (this.startTime || Date.now())
        };
    }
}

// Error handling
process.on('unhandledRejection', (error) => {
    const errorMsg = `💥 Unhandled rejection: ${error.message}`;
    console.error(errorMsg);
    sendTelegramMessage(errorMsg);
});

process.on('SIGINT', () => {
    console.log('\\n🛑 Received SIGINT, shutting down gracefully...');
    if (global.bot) {
        global.bot.stop();
    }
    process.exit(0);
});

// Start the bot
const bot = new ProductionArbitrageBot();
global.bot = bot;

// Run bot cycles
setInterval(async () => {
    if (!bot.isRunning) {
        await bot.start();
    }
}, 5000);

sendTelegramMessage("🤖 Arbitrage bot initialized and ready!");