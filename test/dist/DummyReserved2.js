"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Dummy = void 0;

/**
 * In‐memory repository con capacità massima (FIFO eviction).
 */
var Dummy = /** @class */ (function () {
    function Dummy() {
    }
    Dummy.prototype.dummyFunc = function (x) {
        return x.toString();
    };
    return Dummy;
}());
exports.Dummy = Dummy;
