// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice 24-bucket rolling spend window. Bucket size = windowSecs / 24 (hourly for a 24h window).
library RollingWindow {
    uint256 internal constant BUCKETS = 24;

    struct Buckets {
        uint64[24] slot;
        uint128[24] amt;
    }

    function add(Buckets storage b, uint256 ts, uint32 windowSecs, uint128 amount) internal {
        uint256 bs = windowSecs / BUCKETS;
        uint64 s = uint64(ts / bs);
        uint256 i = s % BUCKETS;
        if (b.slot[i] != s) {
            b.slot[i] = s;
            b.amt[i] = 0;
        }
        b.amt[i] += amount;
    }

    function sum(Buckets storage b, uint256 ts, uint32 windowSecs) internal view returns (uint128 total) {
        uint256 bs = windowSecs / BUCKETS;
        uint64 cur = uint64(ts / bs);
        for (uint256 i; i < BUCKETS; ++i) {
            uint64 s = b.slot[i];
            if (s <= cur && s + BUCKETS > cur) total += b.amt[i];
        }
    }
}
