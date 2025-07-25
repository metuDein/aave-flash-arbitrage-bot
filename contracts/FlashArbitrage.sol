// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@aave/core-v3/contracts/interfaces/IPool.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract FlashArbitrage is IFlashLoanSimpleReceiver {
    address public immutable owner;
    address public immutable pool;
    IPoolAddressesProvider public immutable addressesProvider;

    event ArbitrageProfit(address indexed token, uint256 profit);
    event ArbitrageFailure(string reason);
    event DebugLog(string message, uint256 value);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _addressProvider) {
        owner = msg.sender;
        addressesProvider = IPoolAddressesProvider(_addressProvider);
        pool = addressesProvider.getPool();
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == pool, "Unauthorized");
        require(initiator == owner, "Unauthorized initiator");

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        emit DebugLog("Initial balance", balanceBefore);

        (
            uint256 minProfit,
            address[] memory path,
            bytes[] memory swapData
        ) = abi.decode(params, (uint256, address[], bytes[]));

        for (uint i = 0; i < swapData.length; i++) {
            (bool success, ) = path[i].call(swapData[i]);
            if (!success) {
                emit ArbitrageFailure("Swap failed");
                revert("Swap failed");
            }
        }

        uint256 totalDebt = amount + premium;
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        emit DebugLog("Final balance", finalBalance);

        require(finalBalance >= totalDebt, "Insufficient funds to repay");

        IERC20(asset).approve(pool, totalDebt);

        if (finalBalance > totalDebt) {
            uint256 profit = finalBalance - totalDebt;
            if (profit >= minProfit) {
                IERC20(asset).transfer(owner, profit);
                emit ArbitrageProfit(asset, profit);
            }
        }

        return true;
    }

    function fundContract(address token, uint256 amount) external onlyOwner {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    function withdrawToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }

    function ADDRESSES_PROVIDER()
        external
        view
        override
        returns (IPoolAddressesProvider)
    {
        return addressesProvider;
    }

    function POOL() external view override returns (IPool) {
        return IPool(pool);
    }
}