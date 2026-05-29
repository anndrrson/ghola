pragma circom 2.1.5;

// Ghola shielded batch-auction clearing circuit.
//
// This circuit proves the v1 deterministic clearing policy for a bounded
// 64-order epoch:
//   - every active order is committed into the public auction_order_root
//     using the same sequential Poseidon accumulator the Anchor program uses;
//   - each active order is assigned exactly one of matched or rolled;
//   - matched buys have price >= clearing price, matched sells have
//     price <= clearing price;
//   - rolled buys have price < clearing price, rolled sells have
//     price > clearing price;
//   - matched buy count equals matched sell count.
//
// Public inputs, exactly matching the Anchor verifier wrapper:
//   [0] auction_order_root
//   [1] clearing_price_commitment
//   [2] matched_root
//   [3] rolled_root
//   [4] matched_count
//   [5] rolled_count
//   [6] settlement_commitment
//   [7] clearing_commitment

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

template Bool() {
    signal input in;
    in * (in - 1) === 0;
}

template Select() {
    signal input flag;
    signal input whenFalse;
    signal input whenTrue;
    signal output out;
    component b = Bool();
    b.in <== flag;
    out <== whenFalse + flag * (whenTrue - whenFalse);
}

template AuctionClearing(batchSize, priceBits, amountBits) {
    // --------- PUBLIC INPUTS ---------
    signal input auctionOrderRoot;
    signal input clearingPriceCommitment;
    signal input matchedRoot;
    signal input rolledRoot;
    signal input matchedCount;
    signal input rolledCount;
    signal input settlementCommitment;
    signal input clearingCommitment;

    // --------- PRIVATE INPUTS ---------
    signal input clearingPriceBucket;
    signal input clearingPriceNonce;

    signal input active[batchSize];
    signal input matched[batchSize];
    signal input rolled[batchSize];
    signal input side[batchSize]; // 0 = buy, 1 = sell
    signal input priceBucket[batchSize];
    signal input amountBucket[batchSize];
    signal input institutionCommitment[batchSize];
    signal input orderNonce[batchSize];

    component priceCommit = Poseidon(2);
    priceCommit.inputs[0] <== clearingPriceBucket;
    priceCommit.inputs[1] <== clearingPriceNonce;
    clearingPriceCommitment === priceCommit.out;

    component clearingPriceBits = Num2Bits(priceBits);
    clearingPriceBits.in <== clearingPriceBucket;

    component orderCommit[batchSize];
    component orderRootHash[batchSize];
    component orderRootSelect[batchSize];
    component matchedRootHash[batchSize];
    component matchedRootSelect[batchSize];
    component rolledRootHash[batchSize];
    component rolledRootSelect[batchSize];
    component sideBool[batchSize];
    component activeBool[batchSize];
    component matchedBool[batchSize];
    component rolledBool[batchSize];
    component priceBitsCheck[batchSize];
    component amountBitsCheck[batchSize];
    component priceBelowClearing[batchSize];
    component clearingBelowPrice[batchSize];

    signal orderRootAccum[batchSize + 1];
    signal matchedRootAccum[batchSize + 1];
    signal rolledRootAccum[batchSize + 1];
    signal activeCountAccum[batchSize + 1];
    signal matchedCountAccum[batchSize + 1];
    signal rolledCountAccum[batchSize + 1];
    signal matchedBuyAccum[batchSize + 1];
    signal matchedSellAccum[batchSize + 1];
    signal matchedBuy[batchSize];
    signal matchedSell[batchSize];
    signal rolledBuy[batchSize];
    signal rolledSell[batchSize];
    signal orderIsBuy[batchSize];

    orderRootAccum[0] <== 0;
    matchedRootAccum[0] <== 0;
    rolledRootAccum[0] <== 0;
    activeCountAccum[0] <== 0;
    matchedCountAccum[0] <== 0;
    rolledCountAccum[0] <== 0;
    matchedBuyAccum[0] <== 0;
    matchedSellAccum[0] <== 0;

    for (var i = 0; i < batchSize; i++) {
        activeBool[i] = Bool();
        activeBool[i].in <== active[i];
        matchedBool[i] = Bool();
        matchedBool[i].in <== matched[i];
        rolledBool[i] = Bool();
        rolledBool[i].in <== rolled[i];
        sideBool[i] = Bool();
        sideBool[i].in <== side[i];

        // Active orders are exactly matched or rolled. Inactive slots are neither.
        matched[i] + rolled[i] === active[i];

        priceBitsCheck[i] = Num2Bits(priceBits);
        priceBitsCheck[i].in <== priceBucket[i];
        amountBitsCheck[i] = Num2Bits(amountBits);
        amountBitsCheck[i].in <== amountBucket[i];

        orderCommit[i] = Poseidon(5);
        orderCommit[i].inputs[0] <== side[i];
        orderCommit[i].inputs[1] <== priceBucket[i];
        orderCommit[i].inputs[2] <== amountBucket[i];
        orderCommit[i].inputs[3] <== institutionCommitment[i];
        orderCommit[i].inputs[4] <== orderNonce[i];

        orderRootHash[i] = Poseidon(2);
        orderRootHash[i].inputs[0] <== orderRootAccum[i];
        orderRootHash[i].inputs[1] <== orderCommit[i].out;
        orderRootSelect[i] = Select();
        orderRootSelect[i].flag <== active[i];
        orderRootSelect[i].whenFalse <== orderRootAccum[i];
        orderRootSelect[i].whenTrue <== orderRootHash[i].out;
        orderRootAccum[i + 1] <== orderRootSelect[i].out;

        matchedRootHash[i] = Poseidon(2);
        matchedRootHash[i].inputs[0] <== matchedRootAccum[i];
        matchedRootHash[i].inputs[1] <== orderCommit[i].out;
        matchedRootSelect[i] = Select();
        matchedRootSelect[i].flag <== matched[i];
        matchedRootSelect[i].whenFalse <== matchedRootAccum[i];
        matchedRootSelect[i].whenTrue <== matchedRootHash[i].out;
        matchedRootAccum[i + 1] <== matchedRootSelect[i].out;

        rolledRootHash[i] = Poseidon(2);
        rolledRootHash[i].inputs[0] <== rolledRootAccum[i];
        rolledRootHash[i].inputs[1] <== orderCommit[i].out;
        rolledRootSelect[i] = Select();
        rolledRootSelect[i].flag <== rolled[i];
        rolledRootSelect[i].whenFalse <== rolledRootAccum[i];
        rolledRootSelect[i].whenTrue <== rolledRootHash[i].out;
        rolledRootAccum[i + 1] <== rolledRootSelect[i].out;

        priceBelowClearing[i] = LessThan(priceBits);
        priceBelowClearing[i].in[0] <== priceBucket[i];
        priceBelowClearing[i].in[1] <== clearingPriceBucket;

        clearingBelowPrice[i] = LessThan(priceBits);
        clearingBelowPrice[i].in[0] <== clearingPriceBucket;
        clearingBelowPrice[i].in[1] <== priceBucket[i];

        orderIsBuy[i] <== 1 - side[i];
        matchedBuy[i] <== matched[i] * orderIsBuy[i];
        matchedSell[i] <== matched[i] * side[i];
        rolledBuy[i] <== rolled[i] * orderIsBuy[i];
        rolledSell[i] <== rolled[i] * side[i];

        // Matched buy: price >= clearing, so priceBelowClearing == 0.
        matchedBuy[i] * priceBelowClearing[i].out === 0;
        // Matched sell: price <= clearing, so clearingBelowPrice == 0.
        matchedSell[i] * clearingBelowPrice[i].out === 0;
        // Rolled buy: price < clearing.
        rolledBuy[i] * (1 - priceBelowClearing[i].out) === 0;
        // Rolled sell: price > clearing.
        rolledSell[i] * (1 - clearingBelowPrice[i].out) === 0;

        activeCountAccum[i + 1] <== activeCountAccum[i] + active[i];
        matchedCountAccum[i + 1] <== matchedCountAccum[i] + matched[i];
        rolledCountAccum[i + 1] <== rolledCountAccum[i] + rolled[i];
        matchedBuyAccum[i + 1] <== matchedBuyAccum[i] + matchedBuy[i];
        matchedSellAccum[i + 1] <== matchedSellAccum[i] + matchedSell[i];
    }

    auctionOrderRoot === orderRootAccum[batchSize];
    matchedRoot === matchedRootAccum[batchSize];
    rolledRoot === rolledRootAccum[batchSize];
    matchedCount === matchedCountAccum[batchSize];
    rolledCount === rolledCountAccum[batchSize];
    activeCountAccum[batchSize] === matchedCount + rolledCount;
    matchedBuyAccum[batchSize] === matchedSellAccum[batchSize];

    component clearingHash = Poseidon(7);
    clearingHash.inputs[0] <== auctionOrderRoot;
    clearingHash.inputs[1] <== clearingPriceCommitment;
    clearingHash.inputs[2] <== matchedRoot;
    clearingHash.inputs[3] <== rolledRoot;
    clearingHash.inputs[4] <== matchedCount;
    clearingHash.inputs[5] <== rolledCount;
    clearingHash.inputs[6] <== settlementCommitment;
    clearingCommitment === clearingHash.out;
}

component main { public [
    auctionOrderRoot,
    clearingPriceCommitment,
    matchedRoot,
    rolledRoot,
    matchedCount,
    rolledCount,
    settlementCommitment,
    clearingCommitment
] } = AuctionClearing(64, 16, 16);
