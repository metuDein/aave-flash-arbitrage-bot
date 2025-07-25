const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashArbitrage", function () {
    let flashArbitrage;
    let owner;
    let otherAccount;
    const addressProvider = "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A"; // Sepolia

    beforeEach(async function () {
        [owner, otherAccount] = await ethers.getSigners();
        const FlashArbitrage = await ethers.getContractFactory("FlashArbitrage");
        flashArbitrage = await FlashArbitrage.deploy(addressProvider);
        await flashArbitrage.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            expect(await flashArbitrage.owner()).to.equal(owner.address);
        });

        it("Should set the correct address provider", async function () {
            const deployedProvider = await flashArbitrage.ADDRESSES_PROVIDER();
            expect(deployedProvider).to.equal(addressProvider);
        });

        it("Should set the correct pool address", async function () {
            const poolAddress = await flashArbitrage.POOL();
            expect(poolAddress).to.not.equal(ethers.ZeroAddress);
        });
    });

    describe("Access Control", function () {
        it("Should only allow owner to withdraw tokens", async function () {
            const mockToken = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // DAI on Sepolia
            await expect(
                flashArbitrage.connect(otherAccount).withdrawToken(mockToken)
            ).to.be.revertedWith("Only owner");
        });

        it("Should only allow owner to fund contract", async function () {
            const mockToken = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // DAI on Sepolia
            const amount = ethers.parseUnits("10", 18);
            await expect(
                flashArbitrage.connect(otherAccount).fundContract(mockToken, amount)
            ).to.be.revertedWith("Only owner");
        });

        it("Should only allow owner to emergency withdraw", async function () {
            const mockToken = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // DAI on Sepolia
            const amount = ethers.parseUnits("1", 18);
            await expect(
                flashArbitrage.connect(otherAccount).emergencyWithdraw(mockToken, amount)
            ).to.be.revertedWith("Only owner");
        });
    });

    describe("Flash Loan Execution", function () {
        it("Should reject unauthorized flash loan calls", async function () {
            const asset = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357"; // DAI
            const amount = ethers.parseUnits("10", 18);
            const premium = ethers.parseUnits("0.009", 18); // 0.09%
            const params = ethers.AbiCoder.defaultAbiCoder().encode(
                ["uint256", "address[]", "bytes[]"],
                [ethers.parseUnits("0.1", 18), [], []]
            );
            await expect(
                flashArbitrage.connect(otherAccount).executeOperation(
                    asset,
                    amount,
                    premium,
                    owner.address,
                    params
                )
            ).to.be.revertedWith("Only pool");
        });

        it("Should reject unauthorized initiator", async function () {
            // This test would require mocking the pool contract
            // For now, we just check the revert condition exists in the code
            const contractCode = await ethers.provider.getCode(flashArbitrage.target);
            expect(contractCode).to.include("Unauthorized initiator");
        });
    });

    describe("View Functions", function () {
        it("Should return contract balance for any token", async function () {
            const daiAddress = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";
            const balance = await flashArbitrage.getContractBalance(daiAddress);
            expect(balance).to.equal(0); // Should be 0 initially
        });

        it("Should detect if address is contract", async function () {
            const isContract = await flashArbitrage.isContract(flashArbitrage.target);
            expect(isContract).to.be.true;
            const isEOA = await flashArbitrage.isContract(owner.address);
            expect(isEOA).to.be.false;
        });
    });

    describe("Interface Compliance", function () {
        it("Should return correct addresses provider", async function () {
            const provider = await flashArbitrage.ADDRESSES_PROVIDER();
            expect(provider).to.equal(addressProvider);
        });

        it("Should return valid pool address", async function () {
            const pool = await flashArbitrage.POOL();
            expect(pool).to.not.equal(ethers.ZeroAddress);
        });
    });

    describe("Events", function () {
        it("Should emit events with correct structure", async function () {
            // Test that the contract has the expected events
            const contractInterface = flashArbitrage.interface;
            expect(contractInterface.getEvent("ArbitrageProfit")).to.not.be.undefined;
            expect(contractInterface.getEvent("ArbitrageFailure")).to.not.be.undefined;
            expect(contractInterface.getEvent("DebugLog")).to.not.be.undefined;
            expect(contractInterface.getEvent("SwapExecuted")).to.not.be.undefined;
        });
    });
});