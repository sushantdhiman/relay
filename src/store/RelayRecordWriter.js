/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule RelayRecordWriter
 * @flow
 * @typechecks
 */

'use strict';

const GraphQLMutatorConstants = require('GraphQLMutatorConstants');
const GraphQLRange = require('GraphQLRange');
const RelayConnectionInterface = require('RelayConnectionInterface');
import type {
  Call,
  ClientMutationID,
  DataID,
  FieldValue,
  NodeRangeMap,
  Record,
  Records,
  RootCallMap,
} from 'RelayInternalTypes';
const RelayNodeInterface = require('RelayNodeInterface');
import type RelayQueryPath from 'RelayQueryPath';
const RelayRecord = require('RelayRecord');
import type {RecordState} from 'RelayRecordState';
const RelayRecordStatusMap = require('RelayRecordStatusMap');
import type {CacheWriter} from 'RelayTypes';

const invariant = require('invariant');

const {CURSOR, NODE} = RelayConnectionInterface;
const EMPTY = '';
const FILTER_CALLS = '__filterCalls__';
const FORCE_INDEX = '__forceIndex__';
const RANGE = '__range__';
const RESOLVED_FRAGMENT_MAP = '__resolvedFragmentMap__';
const RESOLVED_FRAGMENT_MAP_GENERATION = '__resolvedFragmentMapGeneration__';
const PATH = '__path__';
const {APPEND, PREPEND, REMOVE} = GraphQLMutatorConstants;

type EdgeData = {
  __dataID__: DataID;
  cursor: mixed;
  node: {
    __dataID__: DataID;
  };
};
type PageInfo = {[key: string]: mixed};

type RangeOperation = 'append' | 'prepend' | 'remove';

/**
 * @internal
 *
 * `RelayRecordWriter` is the helper module to write data into RelayRecordStore.
 */
class RelayRecordWriter {
  _cacheWriter: ?CacheWriter;
  _clientMutationID: ?ClientMutationID;
  _isOptimisticWrite: boolean;
  _records: Records;
  _nodeConnectionMap: NodeRangeMap;
  _rootCallMap: RootCallMap;

  constructor(
    records: Records,
    rootCallMap: RootCallMap,
    isOptimistic: boolean,
    nodeConnectionMap?: ?NodeRangeMap,
    cacheWriter?: ?CacheWriter,
    clientMutationID?: ?ClientMutationID
  ) {
    this._cacheWriter = cacheWriter;
    this._clientMutationID = clientMutationID;
    this._isOptimisticWrite = isOptimistic;
    this._nodeConnectionMap = nodeConnectionMap || {};
    this._records = records;
    this._rootCallMap = rootCallMap;
  }

  /**
   * Get the data ID associated with a storage key (and optionally an
   * identifying argument value) for a root query.
   */
  getDataID(
    storageKey: string,
    identifyingArgValue: ?string
  ): ?DataID {
    if (RelayNodeInterface.isNodeRootCall(storageKey)) {
      invariant(
        identifyingArgValue != null,
        'RelayRecordWriter.getDataID(): Argument to `%s()` ' +
        'cannot be null or undefined.',
        storageKey
      );
      return identifyingArgValue;
    }
    if (identifyingArgValue == null) {
      identifyingArgValue = EMPTY;
    }
    if (this._rootCallMap.hasOwnProperty(storageKey) &&
        this._rootCallMap[storageKey].hasOwnProperty(identifyingArgValue)) {
      return this._rootCallMap[storageKey][identifyingArgValue];
    }
  }

  /**
   * Associate a data ID with a storage key (and optionally an identifying
   * argument value) for a root query.
   */
  putDataID(
    storageKey: string,
    identifyingArgValue: ?string,
    dataID: DataID
  ): void {
    if (RelayNodeInterface.isNodeRootCall(storageKey)) {
      invariant(
        identifyingArgValue != null,
        'RelayRecordWriter.putDataID(): Argument to `%s()` ' +
        'cannot be null or undefined.',
        storageKey
      );
      return;
    }
    if (identifyingArgValue == null) {
      identifyingArgValue = EMPTY;
    }
    this._rootCallMap[storageKey] = this._rootCallMap[storageKey] || {};
    this._rootCallMap[storageKey][identifyingArgValue] = dataID;
    if (this._cacheWriter) {
      this._cacheWriter.writeRootCall(storageKey, identifyingArgValue, dataID);
    }
  }

  /**
   * Returns the status of the record stored at `dataID`.
   */
  getRecordState(dataID: DataID): RecordState {
    const record = this._records[dataID];
    if (record === null) {
      return 'NONEXISTENT';
    } else if (record === undefined) {
      return 'UNKNOWN';
    }
    return 'EXISTENT';
  }

  /**
   * Create an empty record at `dataID` if a record does not already exist.
   */
  putRecord(
    dataID: DataID,
    typeName: ?string,
    path?: RelayQueryPath
  ): void {
    const prevRecord = this._getRecordForWrite(dataID);
    if (prevRecord) {
      return;
    }
    // TODO: Use `RelayRecord`, #9790614.
    const nextRecord: Record = ({
      __dataID__: dataID,
      __typename: typeName,
    }: $FixMe);
    if (this._isOptimisticWrite) {
      this._setClientMutationID(nextRecord);
    }
    if (RelayRecord.isClientID(dataID)) {
      invariant(
        path,
        'RelayRecordWriter.putRecord(): Expected a path for non-refetchable ' +
        'record `%s`.',
        dataID
      );
      nextRecord[PATH] = path;
    }
    this._records[dataID] = nextRecord;
    const cacheWriter = this._cacheWriter;
    if (!this._isOptimisticWrite && cacheWriter) {
      cacheWriter.writeField(dataID, '__dataID__', dataID, typeName);
    }
  }

  /**
   * Returns the path to a non-refetchable record.
   */
  getPathToRecord(
    dataID: DataID
  ): ?RelayQueryPath {
    return (this._getField(dataID, PATH): any);
  }

  /**
   * Check whether a given record has received data for a deferred fragment.
   */
  hasDeferredFragmentData(dataID: DataID, fragmentID: string): boolean {
    const resolvedFragmentMap = this._getField(dataID, RESOLVED_FRAGMENT_MAP);
    invariant(
      typeof resolvedFragmentMap === 'object' || resolvedFragmentMap == null,
      'RelayRecordWriter.hasDeferredFragmentData(): Expected the map of ' +
      'resolved deferred fragments associated with record `%s` to be null or ' +
      'an object. Found a(n) `%s`.',
      dataID,
      typeof resolvedFragmentMap
    );
    return !!(resolvedFragmentMap && resolvedFragmentMap[fragmentID]);
  }

  /**
   * Mark a given record as having received data for a deferred fragment.
   */
  setHasDeferredFragmentData(
    dataID: DataID,
    fragmentID: string
  ): void {
    const record = this._getRecordForWrite(dataID);
    invariant(
      record,
      'RelayRecordWriter.setHasDeferredFragmentData(): Expected record `%s` ' +
      'to exist before marking it as having received data for the deferred ' +
      'fragment with id `%s`.',
      dataID,
      fragmentID
    );
    let resolvedFragmentMap = record[RESOLVED_FRAGMENT_MAP];
    if (typeof resolvedFragmentMap !== 'object' || !resolvedFragmentMap) {
      resolvedFragmentMap = {};
    }
    resolvedFragmentMap[fragmentID] = true;
    record[RESOLVED_FRAGMENT_MAP] = resolvedFragmentMap;
    if (typeof record[RESOLVED_FRAGMENT_MAP_GENERATION] === 'number') {
      record[RESOLVED_FRAGMENT_MAP_GENERATION]++;
    } else {
      record[RESOLVED_FRAGMENT_MAP_GENERATION] = 0;
    }
  }

  /**
   * Delete the record at `dataID`, setting its value to `null`.
   */
  deleteRecord(
    dataID: DataID
  ): void {
    this._records[dataID] = null;

    // Remove any links for this record
    if (!this._isOptimisticWrite) {
      delete this._nodeConnectionMap[dataID];
      if (this._cacheWriter) {
        this._cacheWriter.writeNode(dataID, null);
      }
    }
  }

  getType(dataID: DataID): ?string {
    // `__typename` property is typed as `string`
    return (this._getField(dataID, '__typename'): any);
  }

  /**
   * Returns the value of the field for the given dataID.
   */
  getField(
    dataID: DataID,
    storageKey: string
  ): ?FieldValue {
    return this._getField(dataID, storageKey);
  }

  /**
   * Sets the value of a scalar field.
   */
  putField(
    dataID: DataID,
    storageKey: string,
    value: FieldValue
  ) {
    const record = this._getRecordForWrite(dataID);
    invariant(
      record,
      'RelayRecordWriter.putField(): Expected record `%s` to exist before ' +
      'writing field `%s`.',
      dataID,
      storageKey
    );
    record[storageKey] = value;
    if (!this._isOptimisticWrite && this._cacheWriter) {
      const typeName = record.__typename;
      this._cacheWriter.writeField(dataID, storageKey, value, typeName);
    }
  }

  /**
   * Clears the value of a field by setting it to null/undefined.
   */
  deleteField(
    dataID: DataID,
    storageKey: string
  ): void {
    const record = this._getRecordForWrite(dataID);
    invariant(
      record,
      'RelayRecordWriter.deleteField(): Expected record `%s` to exist before ' +
      'deleting field `%s`.',
      dataID,
      storageKey
    );
    record[storageKey] = null;
    if (!this._isOptimisticWrite && this._cacheWriter) {
      this._cacheWriter.writeField(dataID, storageKey, null);
    }
  }

  /**
   * Returns the Data ID of a linked record (eg the ID of the `address` record
   * in `actor{address}`).
   */
  getLinkedRecordID(
    dataID: DataID,
    storageKey: string
  ): ?DataID {
    const field = this._getField(dataID, storageKey);
    if (field == null) {
      return field;
    }
    invariant(
      typeof field === 'object' &&
        field !== null &&
        !Array.isArray(field),
      'RelayRecordWriter.getLinkedRecordID(): Expected field `%s` for record ' +
      '`%s` to have a linked record.',
      storageKey,
      dataID
    );
    return field.__dataID__;
  }

  /**
   * Creates/updates a link between two records via the given field.
   */
  putLinkedRecordID(
    parentID: DataID,
    storageKey: string,
    recordID: DataID
  ): void {
    const parent = this._getRecordForWrite(parentID);
    invariant(
      parent,
      'RelayRecordWriter.putLinkedRecordID(): Expected record `%s` to exist ' +
      'before linking to record `%s`.',
      parentID,
      recordID
    );
    const record = this._records[recordID];
    invariant(
      record,
      'RelayRecordWriter.putLinkedRecordID(): Expected record `%s` to exist ' +
      'before linking from record `%s`.',
      recordID,
      parentID
    );
    const fieldValue = {
      __dataID__: recordID,
    };
    parent[storageKey] = fieldValue;
    if (!this._isOptimisticWrite && this._cacheWriter) {
      this._cacheWriter.writeField(parentID, storageKey, fieldValue);
    }
  }

  /**
   * Returns an array of Data ID for a plural linked field (eg the actor IDs of
   * the `likers` in `story{likers}`).
   */
  getLinkedRecordIDs(
    dataID: DataID,
    storageKey: string
  ): ?Array<DataID> {
    const field = this._getField(dataID, storageKey);
    if (field == null) {
      return field;
    }
    invariant(
      Array.isArray(field),
      'RelayRecordWriter.getLinkedRecordIDs(): Expected field `%s` for ' +
      'record `%s` to have an array of linked records.',
      storageKey,
      dataID
    );
    return field.map((item, ii) => {
      invariant(
        typeof item === 'object' && item.__dataID__,
        'RelayRecordWriter.getLinkedRecordIDs(): Expected element at index ' +
        '%s in field `%s` for record `%s` to be a linked record.',
        ii,
        storageKey,
        dataID
      );
      return item.__dataID__;
    });
  }

  /**
   * Creates/updates a one-to-many link between records via the given field.
   */
  putLinkedRecordIDs(
    parentID: DataID,
    storageKey: string,
    recordIDs: Array<DataID>
  ): void {
    const parent = this._getRecordForWrite(parentID);
    invariant(
      parent,
      'RelayRecordWriter.putLinkedRecordIDs(): Expected record `%s` to exist ' +
      'before linking records.',
      parentID
    );
    const records = recordIDs.map(recordID => {
      const record = this._records[recordID];
      invariant(
        record,
        'RelayRecordWriter.putLinkedRecordIDs(): Expected record `%s` to ' +
        'exist before linking from `%s`.',
        recordID,
        parentID
      );
      return {
        __dataID__: recordID,
      };
    });
    parent[storageKey] = records;
    if (!this._isOptimisticWrite && this._cacheWriter) {
      this._cacheWriter.writeField(parentID, storageKey, records);
    }
  }

  /**
   * Get the force index associated with the range at `connectionID`.
   */
  getRangeForceIndex(
    connectionID: DataID
  ): number {
    const forceIndex: ?number =
      (this._getField(connectionID, FORCE_INDEX): any);
    if (forceIndex === null) {
      return -1;
    }
    // __forceIndex__ can only be a number
    return forceIndex || 0;
  }

  /**
   * Get the condition calls that were used to fetch the given connection.
   * Ex: for a field `photos.orderby(recent)`, this would be
   * [{name: 'orderby', value: 'recent'}]
   */
  getRangeFilterCalls(
    connectionID: DataID
  ): ?Array<Call> {
    return (this._getField(connectionID, FILTER_CALLS): any);
  }

  /**
   * Creates a range at `dataID` with an optional `forceIndex`.
   */
  putRange(
    connectionID: DataID,
    calls: Array<Call>,
    forceIndex?: ?number
  ): void {
    invariant(
      !this._isOptimisticWrite,
      'RelayRecordWriter.putRange(): Cannot create a queued range.'
    );
    const record = this._getRecordForWrite(connectionID);
    invariant(
      record,
      'RelayRecordWriter.putRange(): Expected record `%s` to exist before ' +
      'adding a range.',
      connectionID
    );
    const range = new GraphQLRange();
    const filterCalls = getFilterCalls(calls);
    forceIndex = forceIndex || 0;
    record.__filterCalls__ = filterCalls;
    record.__forceIndex__ = forceIndex;
    record.__range__ = range;

    const cacheWriter = this._cacheWriter;
    if (!this._isOptimisticWrite && cacheWriter) {
      cacheWriter.writeField(connectionID, FILTER_CALLS, filterCalls);
      cacheWriter.writeField(connectionID, FORCE_INDEX, forceIndex);
      cacheWriter.writeField(connectionID, RANGE, range);
    }
  }

  /**
   * Returns whether there is a range at `connectionID`.
   */
  hasRange(connectionID: DataID): boolean {
    return !!this._getField(connectionID, RANGE);
  }

  /**
   * Adds newly fetched edges to a range.
   */
  putRangeEdges(
    connectionID: DataID,
    calls: Array<Call>,
    pageInfo: PageInfo,
    edges: Array<DataID>
  ): void {
    const range: ?GraphQLRange = (this._getField(connectionID, RANGE): any);
    invariant(
      range,
      'RelayRecordWriter.putRangeEdges(): Expected record `%s` to exist and ' +
      'have a range.',
      connectionID
    );
    const edgesData = [];
    edges.forEach(edgeID => {
      const edgeData = this._getRangeEdgeData(edgeID);
      edgesData.push(edgeData);
      this._addConnectionForNode(connectionID, edgeData.node.__dataID__);
    });
    range.addItems(
      calls,
      edgesData,
      pageInfo
    );
    if (!this._isOptimisticWrite && this._cacheWriter) {
      this._cacheWriter.writeField(connectionID, RANGE, range);
    }
  }

  /**
   * Prepend, append, or delete edges to/from a range.
   */
  applyRangeUpdate(
    connectionID: DataID,
    edgeID: DataID,
    operation: RangeOperation
  ): void {
    if (this._isOptimisticWrite) {
      this._applyOptimisticRangeUpdate(connectionID, edgeID, operation);
    } else {
      this._applyServerRangeUpdate(connectionID, edgeID, operation);
    }
  }

  /**
   * Get edge data in a format compatibile with `GraphQLRange`.
   * TODO: change `GraphQLRange` to accept `(edgeID, cursor, nodeID)` tuple
   */
  _getRangeEdgeData(edgeID: DataID): EdgeData {
    const nodeID = this.getLinkedRecordID(edgeID, NODE);
    invariant(
      nodeID,
      'RelayRecordWriter: Expected edge `%s` to have a `node` record.',
      edgeID
    );
    return {
      __dataID__: edgeID,
      cursor: this.getField(edgeID, CURSOR),
      node: {
        __dataID__: nodeID,
      },
    };
  }

  _applyOptimisticRangeUpdate(
    connectionID: DataID,
    edgeID: DataID,
    operation: RangeOperation
  ): void {
    let record: ?Record = this._getRecordForWrite(connectionID);
    if (!record) {
      // $FlowIssue: this fails with:
      // "property `append/prepend/remove` not found in object literal"
      record = ({__dataID__: connectionID}: $FlowIssue);
      this._records[connectionID] = record;
      this._setClientMutationID(record);
    }
    let queue: ?Array<DataID> = (record[operation]: any);
    if (!queue) {
      queue = [];
      record[operation] = queue;
    }
    if (operation === PREPEND) {
      queue.unshift(edgeID);
    } else {
      queue.push(edgeID);
    }
  }

  _applyServerRangeUpdate(
    connectionID: DataID,
    edgeID: DataID,
    operation: RangeOperation
  ): void {
    const range: ?GraphQLRange = (this._getField(connectionID, RANGE): any);
    invariant(
      range,
      'RelayRecordWriter: Cannot apply `%s` update to non-existent record ' +
      '`%s`.',
      operation,
      connectionID
    );
    if (operation === REMOVE) {
      range.removeEdgeWithID(edgeID);
      const nodeID = this.getLinkedRecordID(edgeID, 'node');
      if (nodeID) {
        this._removeConnectionForNode(connectionID, nodeID);
      }
    } else {
      const edgeData = this._getRangeEdgeData(edgeID);
      this._addConnectionForNode(connectionID, edgeData.node.__dataID__);
      if (operation === APPEND) {
        range.appendEdge(this._getRangeEdgeData(edgeID));
      } else {
        // prepend
        range.prependEdge(this._getRangeEdgeData(edgeID));
      }
    }
    if (this._cacheWriter) {
      this._cacheWriter.writeField(connectionID, RANGE, range);
    }
  }

  /**
   * Record that the node is contained in the connection.
   */
  _addConnectionForNode(
    connectionID: DataID,
    nodeID: DataID
  ): void {
    let connectionMap = this._nodeConnectionMap[nodeID];
    if (!connectionMap) {
      connectionMap = {};
      this._nodeConnectionMap[nodeID] = connectionMap;
    }
    connectionMap[connectionID] = true;
  }

  /**
   * Record that the given node is no longer part of the connection.
   */
  _removeConnectionForNode(
    connectionID: DataID,
    nodeID: DataID
  ): void {
    const connectionMap = this._nodeConnectionMap[nodeID];
    if (connectionMap) {
      delete connectionMap[connectionID];
      if (Object.keys(connectionMap).length === 0) {
        delete this._nodeConnectionMap[nodeID];
      }
    }
  }

  /**
   * If the record is in the store, gets a version of the record
   * in the store being used for writes.
   */
  _getRecordForWrite(dataID: DataID): ?Record {
    const record = this._records[dataID];
    if (!record) {
      return record;
    }
    if (this._isOptimisticWrite) {
      this._setClientMutationID(record);
    }
    return record;
  }

  /**
   * Get the value of the field from the first version of the record for which
   * the field is defined, returning `null` if the record has been deleted or
   * `undefined` if the record has not been fetched.
   */
  _getField(dataID: DataID, storageKey: string): ?FieldValue {
    const record = this._records[dataID];
    if (record === null) {
      return null;
    } else if (record && record.hasOwnProperty(storageKey)) {
      return record[storageKey];
    } else {
      return undefined;
    }
  }

  /**
   * Injects the client mutation id associated with the record store instance
   * into the given record.
   */
  _setClientMutationID(record: Record): void {
    const clientMutationID = this._clientMutationID;
    invariant(
      clientMutationID,
      'RelayRecordWriter: _clientMutationID cannot be null/undefined.'
    );
    const mutationIDs: Array<ClientMutationID> = record.__mutationIDs__ || [];
    if (mutationIDs.indexOf(clientMutationID) === -1) {
      mutationIDs.push(clientMutationID);
      record.__mutationIDs__ = mutationIDs;
    }
    record.__status__ = RelayRecordStatusMap.setOptimisticStatus(
      0,
      true
    );
  }
}

/**
 * Filter calls to only those that specify conditions on the returned results
 * (ex: `orderby(TOP_STORIES)`), removing generic calls (ex: `first`, `find`).
 */
function getFilterCalls(calls: Array<Call>): Array<Call> {
  return calls.filter(call => !RelayConnectionInterface.isConnectionCall(call));
}

module.exports = RelayRecordWriter;