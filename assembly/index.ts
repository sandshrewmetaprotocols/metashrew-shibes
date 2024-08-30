import { Box, RCBox } from "metashrew-as/assembly/utils/box";
import { _flush, input, get, set } from "metashrew-as/assembly/indexer/index";
import { parseBytes, parsePrimitive, concat, reverse, primitiveToBuffer } from "metashrew-as/assembly/utils/utils";
import { Block } from "metashrew-as/assembly/blockdata/block";
import {
  Transaction,
  Input,
  Output,
  OutPoint,
} from "metashrew-as/assembly/blockdata/transaction";
import { console } from "metashrew-as/assembly/utils/logging";
import { toRLP, RLPItem } from "metashrew-as/assembly/utils/rlp";
import {
  encodeHexFromBuffer,
  encodeHex,
} from "metashrew-as/assembly/utils/hex";
import { Inscription } from "metashrew-as/assembly/blockdata/inscription";
import { subsidy } from "metashrew-as/assembly/utils/ordinals";
import { Height } from "metashrew-as/assembly/blockdata/height";
import { Sat, SatPoint } from "metashrew-as/assembly/blockdata/sat";
import { JUBILEE_HEIGHT } from "./constants";
import { BST } from "metashrew-as/assembly/indexer/bst";

import { ordinals } from "./protobuf";
import { SUBSIDIES_TABLE } from "./subsidies";

import {
  SAT_TO_OUTPOINT,
  OUTPOINT_TO_SAT,
  OUTPOINT_TO_VALUE,
  OUTPOINT_TO_SEQUENCE_NUMBERS,
  HEIGHT_TO_BLOCKHASH,
  BLOCKHASH_TO_HEIGHT,
  STARTING_SAT,
  INSCRIPTION_ID_TO_INSCRIPTION,
  SATPOINT_TO_INSCRIPTION_ID,
  SATPOINT_TO_SAT,
  INSCRIPTION_ID_TO_SATPOINT,
  INSCRIPTION_ID_TO_BLOCKHEIGHT,
  HEIGHT_TO_INSCRIPTION_IDS,
  NEXT_SEQUENCE_NUMBER,
  SEQUENCE_NUMBER_TO_INSCRIPTION_ID,
  INSCRIPTION_ID_TO_SEQUENCE_NUMBER,
} from "./tables";

export function trap(): void {
  unreachable();
}

function reverseOutput(v: ArrayBuffer): ArrayBuffer {
  return Box.concat([ Box.from(reverse(Box.from(v).shrinkBack(4).toArrayBuffer())), Box.from(v).shrinkFront(32) ]);
}

function rangeLength<K>(bst: BST<K>, key: K, max: K): K {
  const greater = bst.seekGreater(key);
  if (greater > max || greater === 0) return max - key;
  return greater - key;
}

function min<T>(a: T, b: T): T {
  if (a > b) return b;
  return a;
}

function max<T>(a: T, b: T): T {
  if (a < b) return b;
  return a;
}

function flatten<T>(ary: Array<Array<T>>): Array<T> {
  const result: Array<T> = new Array<T>(0);
  for (let i = 0; i < ary.length; i++) {
    for (let j = 0; j < ary[i].length; j++) {
      result.push(ary[i][j]);
    }
  }
  return result;
}

function toID(satpoint: ArrayBuffer, index: u32): ArrayBuffer {
  return Box.concat([
    Box.from(satpoint),
    Box.from(primitiveToBuffer<u32>(index)),
  ]);
}

class SatRanges {
  public sats: Array<u64>;
  public distances: Array<u64>;
  constructor(sats: Array<u64>, distances: Array<u64>) {
    this.sats = sats;
    this.distances = distances;
    /*
    for (let i = 0; i < this.sats.length; i++) {
      console.log('range:[' + this.sats[0].toString(10) + ', ' + this.distances[0].toString(10) + ']');
    }
    console.log('ranges constructed');
   */
  }
  join(): SatRanges {
    const sats = new Array<u64>(0);
    const distances = new Array<u64>(0);
    for (let i = 0; i < this.sats.length; i++) {
      let sat = this.sats[i];
      let distance = this.distances[i];
      while (i < this.sats.length) {
        if (i !== this.sats.length - 1 && sat + distance === this.sats[i + 1]) {
          distance += this.distances[i];
	  i++;
	} else break;
      }
      sats.push(sat);
      distances.push(distance);
    }
    this.sats = sats;
    this.distances = distances;
    return this;
  }
  static fromSats(sats: Array<u64>, rangeEnd: u64): SatRanges {
	  /*
    sats.sort((a: u64, b: u64) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
   */
    const distances = new Array<u64>(max(sats.length, 1));
    for (let i = 0; i < sats.length; i++) {
      distances[i] = rangeLength<u64>(SAT_TO_OUTPOINT, sats[i], rangeEnd);
    }
    return new SatRanges(sats, distances);
  }
  pull(): SatRanges {
	  /*
    console.log('pull sats:');
    for (let i = 0; i < this.sats.length; i++) {
      console.log(this.sats[i].toString(10));
    }
   */
    this.sats.forEach((v: u64, i: i32, ary: Array<u64>) => {
      setSat(v, new ArrayBuffer(0));
    });
    return this;
  }
  static fromTransaction(tx: Transaction, rangeEnd: u64): SatRanges {
    return SatRanges.fromSats(flatten(tx.ins.map<Array<u64>>((v: Input) => OUTPOINT_TO_SAT.select(v.previousOutput().toArrayBuffer()).getListValues<u64>())), rangeEnd);
  }
}

class SatSource {
  public ranges: SatRanges;
  public pointer: i32;
  public offset: u64;
  constructor(ranges: SatRanges) {
    this.ranges = ranges;
  }
  static fromTransaction(tx: Transaction, rangeEnd: u64): SatSource {
    return new SatSource(SatRanges.fromTransaction(tx, rangeEnd));
  }
  consumed(): boolean {
    return (
      this.pointer >= this.ranges.sats.length ||
      (this.pointer === this.ranges.sats.length - 1 &&
        this.offset >= this.ranges.distances[this.ranges.distances.length - 1])
    );
  }
  pull(): SatSource {
    this.ranges.pull().join();
    return this;
  }
  static range(sat: u64, distance: u64): SatSource {
    const sats = new Array<u64>(1);
    sats[0] = sat;
    const distances = new Array<u64>(1);
    distances[0] = distance;
    return new SatSource(new SatRanges(sats, distances));
  }
}

class SatSink {
  public target: Transaction;
  public pointer: i32;
  public offset: u64;
  constructor(target: Transaction) {
    this.target = target;
  }
  filled(): boolean {
    return (
      this.pointer >= this.target.outs.length ||
      (this.pointer === this.target.outs.length - 1 &&
        this.offset >= this.target.outs[this.target.outs.length - 1].value)
    );
  }
  currentOutpoint(): ArrayBuffer {
    return OutPoint.from(this.target.txid(), this.pointer).toArrayBuffer();
  }
  consume(source: SatSource): void {
	  /*
    console.log(Box.from(this.target.txid()).toHexString());
    console.log(source.consumed() ? "consumed" : "not consumed");
    console.log(this.filled() ? "filled" : "not filled");
    source.ranges.sats.forEach((v: u64, i: i32, ary: Array<u64>) => {
      console.log('sat:' + v.toString(10));
    });
    source.ranges.distances.forEach((v: u64, i: i32, ary: Array<u64>) => {
      console.log('distance:' + v.toString(10));
    });
   */
    while (!source.consumed() && !this.filled()) {
      const sourceRemaining =
        source.ranges.distances[source.pointer] - source.offset;
      const targetRemaining =
        this.target.outs[this.pointer].value - this.offset;
      const outpoint = this.currentOutpoint();
      const sat = source.ranges.sats[source.pointer] + source.offset;
      /*
      source.ranges.sats.forEach((v: u64, i: i32, ary: Array<u64>) => {
        console.log(v.toString(10));
      });
      console.log(sat.toString());
     */
      setSat(sat, outpoint);
      OUTPOINT_TO_SAT.select(outpoint).appendValue<u64>(sat);
      if (targetRemaining < sourceRemaining) {
        this.pointer++;
        this.offset = 0;
        source.offset += targetRemaining;
      } else if (sourceRemaining < targetRemaining) {
        source.pointer++;
        source.offset = 0;
        this.offset += sourceRemaining;
      } else {
        source.offset = 0;
        source.pointer++;
        this.offset = 0;
        this.pointer++;
      }
    }
  }
  static fromTransaction(tx: Transaction): SatSink {
    return new SatSink(tx);
  }
}

function setSat(sat: u64, outpoint: ArrayBuffer): void {
//  console.log(sat.toString(10) + ":" + Box.from(outpoint).toHexString());
  SAT_TO_OUTPOINT.set(sat, outpoint);
  if (outpoint.byteLength === 0) SAT_TO_OUTPOINT.unmarkPath(sat);
}

function excessSats(source: SatSource): void {
  while (!source.consumed()) {
    const sourceRemaining =
      source.ranges.distances[source.pointer] - source.offset;
    const outpoint = new ArrayBuffer(36);
    store<u32>(changetype<usize>(outpoint) + 34, bswap<u16>(0xdead));
    const sat = source.ranges.sats[source.pointer] + source.offset;
    setSat(sat, outpoint);
    OUTPOINT_TO_SAT.select(outpoint).appendValue<u64>(sat);
    source.offset = 0;
    source.pointer++;
  }
}

function blockReward(height: u64): u64 {
  if (<i32>height < SUBSIDIES_TABLE.length) return SUBSIDIES_TABLE[<i32>height];
  if (height < 600000) return <u64>250000 / <u64>((<u64>1) << ((<u64>height / 100000) - 1));
  return <u64>10000;
}

class Index {
  static indexTransactionInscriptions(
    tx: Transaction,
    txid: ArrayBuffer,
    height: u32,
  ): void {
    const jubilant = height >= JUBILEE_HEIGHT;
    let total = 0;
    let offset: u64 = 0;
    let outputIndex: i32 = 0;
    for (let i = 0; i < tx.ins.length; i++) {
      if (outputIndex >= tx.outs.length) break;
      const inscription = tx.ins[i].inscription();
      if (inscription !== null) {
        const sequenceNumber = NEXT_SEQUENCE_NUMBER.getValue<u64>();
        const outpoint = OutPoint.from(txid, <u32>outputIndex).toArrayBuffer();
        const satpoint = SatPoint.from(outpoint, <u64>offset).toArrayBuffer();
        const value = OUTPOINT_TO_VALUE.select(
          tx.ins[i].previousOutput().toArrayBuffer(),
        ).getValue<u64>();
        offset += value;
        if (offset >= tx.outs[outputIndex].value) {
          outputIndex++;
          offset = 0;
        }
        const sat = OUTPOINT_TO_SAT.select(outpoint)
          .selectIndex(0)
          .getValue<u64>();
        const inscriptionId = toID(satpoint, 0);
        SATPOINT_TO_SAT.select(satpoint).setValue<u64>(sat);
        SATPOINT_TO_INSCRIPTION_ID.select(satpoint).set(inscriptionId);
        INSCRIPTION_ID_TO_SATPOINT.select(inscriptionId).set(satpoint);
        INSCRIPTION_ID_TO_BLOCKHEIGHT.select(inscriptionId).setValue<u32>(
          height,
        );
        HEIGHT_TO_INSCRIPTION_IDS.selectValue<u32>(height).append(
          inscriptionId,
        );
        SEQUENCE_NUMBER_TO_INSCRIPTION_ID.selectValue<u64>(sequenceNumber).set(
          inscriptionId,
        );
        INSCRIPTION_ID_TO_SEQUENCE_NUMBER.select(inscriptionId).setValue<u64>(
          sequenceNumber,
        );
        INSCRIPTION_ID_TO_INSCRIPTION.select(inscriptionId).set(
          inscription.toArrayBuffer(),
        );
        OUTPOINT_TO_SEQUENCE_NUMBERS.select(outpoint).appendValue<u64>(
          sequenceNumber,
        );
      } else {
        const previousOutput = tx.ins[i].previousOutput().toArrayBuffer();
        const inscriptionsForOutpoint =
          OUTPOINT_TO_SEQUENCE_NUMBERS.select(
            previousOutput,
          ).getListValues<u64>();
        for (let j = 0; j < inscriptionsForOutpoint.length; j++) {
          const inscriptionId =
            SEQUENCE_NUMBER_TO_INSCRIPTION_ID.selectValue<u64>(
              inscriptionsForOutpoint[j],
            ).get();
          const previousSatPoint =
            INSCRIPTION_ID_TO_SATPOINT.select(inscriptionId).get();
          const sat = SATPOINT_TO_SAT.select(previousSatPoint).getValue<u64>();
          const startingSat = SAT_TO_OUTPOINT.seekLower(sat + 1);
          const outpoint = SAT_TO_OUTPOINT.get(startingSat);
          const satpoint = SatPoint.from(
            outpoint,
            sat - startingSat,
          ).toArrayBuffer();
          SATPOINT_TO_SAT.select(satpoint).setValue<u64>(sat);
          SATPOINT_TO_INSCRIPTION_ID.select(satpoint).set(inscriptionId);
          INSCRIPTION_ID_TO_SATPOINT.select(inscriptionId).set(satpoint);
          OUTPOINT_TO_SEQUENCE_NUMBERS.select(outpoint).appendValue<u64>(
            inscriptionsForOutpoint[j],
          );
        }
      }
    }
  }

  static totalOutputs(tx: Transaction): u64 {
    let total: u64 = 0;
    for (let i: i32 = 0; i < tx.outs.length; i++) {
      total += tx.outs[i].value;
    }
    return total;
  }
  static totalInputs(tx: Transaction): u64 {
    let total: u64 = 0;
    for (let i: i32 = 0; i < tx.ins.length; i++) {
      total += OUTPOINT_TO_VALUE.select(
        tx.ins[i].previousOutput().toArrayBuffer(),
      ).getValue<u64>();
    }
    return total;
  }
  static transactionFeesForBlock(block: Block): u64 {
    let total: u64 = 0;
    for (let i: i32 = 1; i < block.transactions.length; i++) {
      const tx = block.transactions[i];
      total += Index.totalInputs(tx) - Index.totalOutputs(tx);
    }
    return total;
  }
  static indexOutputValuesForTransaction(tx: Transaction): void {
    const txid = tx.txid();
    for (let i = 0; i < tx.outs.length; i++) {
      OUTPOINT_TO_VALUE.select(OutPoint.from(txid, i).toArrayBuffer()).setValue(
        tx.outs[i].value,
      );
    }
  }
  static indexOutputValuesForBlock(block: Block): void {
    for (let i = 0; i < block.transactions.length; i++) {
      Index.indexOutputValuesForTransaction(block.transactions[i]);
    }
  }
  static sortOutPoints(tx: Transaction): void {
    const txid = tx.txid();
    for (let i = 0; i < tx.outs.length; i++) {
      const outpoint = OutPoint.from(txid, i).toArrayBuffer();
      const sats = OUTPOINT_TO_SAT.select(outpoint).getListValues<u64>().sort((a: u64, b: u64) => {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
      });
      for (let j = 0; j < sats.length; j++) {
        OUTPOINT_TO_SAT.selectIndex(j).setValue<u64>(sats[j]);
      }
    }
  }
  static indexBlock(height: u32, block: Block): void {
    HEIGHT_TO_BLOCKHASH.selectValue<u32>(height).set(block.blockhash());
    BLOCKHASH_TO_HEIGHT.select(block.blockhash()).setValue<u32>(height);
    Index.indexOutputValuesForBlock(block);
    const coinbase = block.coinbase();
    let startingSat = STARTING_SAT.getValue<u64>();
    const reward = blockReward(height);
    STARTING_SAT.setValue<u64>(startingSat + reward);
    const coinbaseSource = SatSource.range(startingSat, reward);
    const coinbaseSink = SatSink.fromTransaction(coinbase);
    coinbaseSink.consume(coinbaseSource);

    for (let i: i32 = 1; i < block.transactions.length; i++) {
      const tx = block.transactions[i];
      const transactionSink = SatSink.fromTransaction(tx);
      const transactionSource = SatSource.fromTransaction(tx, startingSat).pull();
      transactionSink.consume(transactionSource);
      const txid = tx.txid();
      if (!transactionSource.consumed()) coinbaseSink.consume(transactionSource);
      if (!transactionSource.consumed() && coinbaseSink.filled()) excessSats(transactionSource);
      Index.indexTransactionInscriptions(tx, txid, height);
    }
    excessSats(coinbaseSource);
  }
}

function decodeHex(hex: string): ArrayBuffer {
  const result = new ArrayBuffer(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    store<u8>(
      changetype<usize>(result) + i / 2,
      <u8>parseInt(hex.substring(i, i + 2), 16),
    );
  }
  return result;
}

export function _start(): void {
  const data = input();
  const box = Box.from(data);
  const height = parsePrimitive<u32>(box);
  const block = new Block(box);
  console.log(block.transactions.length.toString(10));
  Index.indexBlock(height, block);
  _flush();
}

function outpointToSatRanges(outpoint: OutPoint): ordinals.SatRanges {
  const sats = OUTPOINT_TO_SAT.select(outpoint.toArrayBuffer()).getListValues<u64>();
  const result = new ordinals.SatRanges();
  const distances = sats.map<u64>((v: u64, i: i32, ary: Array<u64>) => {
    return rangeLength<u64>(SAT_TO_OUTPOINT, v, STARTING_SAT.getValue<u64>());
  });
  for (let i = 0; i < sats.length; i++) {
    const range = new ordinals.SatRange();
    range.start = sats[i];
    range.distance = distances[i];
    result.ranges.push(range);
  }
  return result;
}

export function satranges(): ArrayBuffer {
  const box = Box.from(input());
  const height = parsePrimitive<u32>(box);
  const data = box.toArrayBuffer();
  const request = ordinals.SatRangesRequest.decode(data);
  const outpoint = OutPoint.from(request.outpoint.hash.buffer, request.outpoint.vout);
  const response = new ordinals.SatRangesResponse();
  response.satranges = outpointToSatRanges(outpoint);
  return response.encode();
}

function arrayBufferToArray(data: ArrayBuffer): Array<u8> {
  const result = new Array<u8>(data.byteLength);
  store<usize>(changetype<usize>(result), changetype<usize>(data));
  store<usize>(changetype<usize>(result) + sizeof<usize>(), changetype<usize>(data));
  return result;
}

export function sat(): ArrayBuffer {
  const box = Box.from(input());
  const height = parsePrimitive<u32>(box);
  const data = box.toArrayBuffer();
  const request = ordinals.SatRequest.decode(data);
  const response = new ordinals.SatResponse();
  const start = SAT_TO_OUTPOINT.seekLower(request.sat + 1);
  response.pointer = request.sat - start;
  const outpoint = new OutPoint(Box.from(reverseOutput(SAT_TO_OUTPOINT.get(start))));
  response.outpoint.hash = arrayBufferToArray(outpoint.txid.toArrayBuffer());
  response.outpoint.vout = outpoint.index;
  response.satrange.start = start;
  response.satrange.distance = rangeLength<u64>(SAT_TO_OUTPOINT, start, STARTING_SAT.getValue<u64>());
  response.satranges = outpointToSatRanges(outpoint);
  return response.encode();
}

export function inscription(): ArrayBuffer {
  const data = input();
  return data;
}

export function content(): ArrayBuffer {
  const number = parsePrimitive<u32>(Box.from(input()));
  const inscriptionId = SEQUENCE_NUMBER_TO_INSCRIPTION_ID.selectValue<u64>(
    <u64>number,
  ).get();
  return INSCRIPTION_ID_TO_INSCRIPTION.select(inscriptionId).get();
}

export function inscriptionsfrom(): ArrayBuffer {
  const data = input();
  return data;
}

export function inscriptionsforblock(): ArrayBuffer {
  const height = parsePrimitive<u32>(Box.from(input()));
  return new ArrayBuffer(0);
}

export function output(): ArrayBuffer {
  const data = Box.from(input());
  const outpoint = parseBytes(data, 32);
  const vout = parsePrimitive<u32>(data);
  return new ArrayBuffer(0);
}

export function test_arrayBufferCopy(): void {
  const buffer = new ArrayBuffer(4);
  store<u32>(changetype<usize>(buffer), 0x55443322);
  const ary = new Array<u8>(4);
  store<usize>(changetype<usize>(ary), changetype<usize>(buffer));
  store<usize>(changetype<usize>(ary) + sizeof<usize>(), changetype<usize>(buffer));
}

export function test_nullTx(): void {
  const buffer = new Transaction(Box.from(new ArrayBuffer(0)));
  console.log(Box.from(buffer.txid()).toHexString());
}
