// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal controller scaffold for Ghola-managed Hyperliquid native vaults.
/// @dev This contract records controller state and emits auditable intents. The
/// production CoreWriter/HyperCore call must be wired to the official HyperEVM
/// interface before deployment.
contract GholaHyperliquidVaultController {
    address public owner;
    address public gholaOperator;
    address public vaultAddress;
    address public agentWallet;

    mapping(bytes32 requestId => bool recorded) public depositReceipts;

    event OwnerTransferred(address indexed previousOwner, address indexed nextOwner);
    event OperatorUpdated(address indexed operator);
    event VaultAddressRecorded(address indexed vaultAddress);
    event AgentWalletUpdated(address indexed agentWallet);
    event DepositReceiptRecorded(bytes32 indexed receiptCommitment, address indexed vaultAddress);
    event CoreWriterIntent(bytes32 indexed intentCommitment, address indexed vaultAddress, address indexed agentWallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "Ghola: owner only");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || msg.sender == gholaOperator, "Ghola: operator only");
        _;
    }

    constructor(address initialOperator) {
        owner = msg.sender;
        gholaOperator = initialOperator;
        emit OwnerTransferred(address(0), msg.sender);
        emit OperatorUpdated(initialOperator);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "Ghola: zero owner");
        emit OwnerTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    function setOperator(address nextOperator) external onlyOwner {
        gholaOperator = nextOperator;
        emit OperatorUpdated(nextOperator);
    }

    function recordVaultAddress(address nextVaultAddress) external onlyOperator {
        require(nextVaultAddress != address(0), "Ghola: zero vault");
        vaultAddress = nextVaultAddress;
        emit VaultAddressRecorded(nextVaultAddress);
    }

    function setAgentWallet(address nextAgentWallet) external onlyOperator {
        require(nextAgentWallet != address(0), "Ghola: zero agent");
        agentWallet = nextAgentWallet;
        emit AgentWalletUpdated(nextAgentWallet);
    }

    function recordDepositReceipt(bytes32 receiptCommitment) external onlyOperator {
        require(vaultAddress != address(0), "Ghola: vault missing");
        require(receiptCommitment != bytes32(0), "Ghola: receipt missing");
        depositReceipts[receiptCommitment] = true;
        emit DepositReceiptRecorded(receiptCommitment, vaultAddress);
    }

    function emitCoreWriterIntent(bytes32 intentCommitment) external onlyOperator {
        require(vaultAddress != address(0), "Ghola: vault missing");
        require(agentWallet != address(0), "Ghola: agent missing");
        require(intentCommitment != bytes32(0), "Ghola: intent missing");
        emit CoreWriterIntent(intentCommitment, vaultAddress, agentWallet);
    }
}
