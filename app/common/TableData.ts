/**
 * TableData maintains a single table's data.
 */
import {getDefaultForType} from 'app/common/gristTypes';
import fromPairs = require('lodash/fromPairs');
import {ActionDispatcher} from './ActionDispatcher';
import {BulkColValues, CellValue, ColInfo, ColInfoWithId, ColValues, DocAction,
        isSchemaAction, ReplaceTableData, RowRecord, TableDataAction} from './DocActions';
import {arrayRemove, arraySplice} from './gutil';

export interface ColTypeMap { [colId: string]: string; }

interface ColData {
  colId: string;
  type: string;
  defl: any;
  values: CellValue[];
}

/**
 * TableData class to maintain a single table's data.
 *
 * In the browser's memory, table data needs a representation that's reasonably compact. We
 * represent it as column-wise arrays. (An early hope was to allow use of TypedArrays, but since
 * types can be mixed, those are not used.)
 */
export class TableData extends ActionDispatcher {
  private _tableId: string;
  private _isLoaded: boolean = false;
  private _fetchPromise?: Promise<void>;

  // Storage of the underlying data. Each column is an array, all of the same length. Includes
  // 'id' column, containing a reference to _rowIdCol.
  private _columns: Map<string, ColData> = new Map();

  // Array of all ColData objects, omitting 'id'.
  private _colArray: ColData[] = [];

  // The `id` column is direct reference to the 'id' column, and contains row ids.
  private _rowIdCol: number[] = [];

  // Maps row id to index in the arrays in _columns. I.e. it's the inverse of _rowIdCol.
  private _rowMap: Map<number, number> = new Map();

  constructor(tableId: string, tableData: TableDataAction|null, colTypes: ColTypeMap) {
    super();
    this._tableId = tableId;

    // Initialize all columns to empty arrays, while nothing is yet loaded.
    for (const colId in colTypes) {
      if (colTypes.hasOwnProperty(colId)) {
        const type = colTypes[colId];
        const defl = getDefaultForType(type);
        const colData: ColData = { colId, type, defl, values: [] };
        this._columns.set(colId, colData);
        this._colArray.push(colData);
      }
    }
    this._columns.set('id', {colId: 'id', type: 'Id', defl: 0, values: this._rowIdCol});

    if (tableData) {
      this.loadData(tableData);
    }
    // TODO: We should probably unload big sets of data when no longer needed. This can be left for
    // when we support loading only parts of a table.
  }

  /**
   * Fetch data (as long as a fetch is not in progress), and load it in memory when done.
   * Returns a promise that's resolved when data finishes loading, and isLoaded becomes true.
   */
  public fetchData(fetchFunc: (tableId: string) => Promise<TableDataAction>): Promise<void> {
    if (!this._fetchPromise) {
      this._fetchPromise = fetchFunc(this._tableId).then(data => {
        this._fetchPromise = undefined;
        this.loadData(data);
      });
    }
    return this._fetchPromise;
  }

  /**
   * Populates the data for this table. Returns the array of old rowIds that were loaded before.
   */
  public loadData(tableData: TableDataAction|ReplaceTableData): number[] {
    const rowIds: number[] = tableData[2];
    const colValues: BulkColValues = tableData[3];
    const oldRowIds: number[] = this._rowIdCol.slice(0);

    reassignArray(this._rowIdCol, rowIds);
    for (const colData of this._colArray) {
      const values = colValues[colData.colId];
      // If colId is missing from tableData, use an array of default values. Note that reusing
      // default value like this is only OK because all default values we use are primitive.
      reassignArray(colData.values, values || this._rowIdCol.map(() => colData.defl));
    }

    this._rowMap.clear();
    for (let i = 0; i < rowIds.length; i++) {
      this._rowMap.set(rowIds[i], i);
    }

    this._isLoaded = true;
    return oldRowIds;
  }

  // Used by QuerySet to load new rows for onDemand tables.
  public loadPartial(data: TableDataAction): void {
    // Add the new rows, reusing BulkAddData code.
    const rowIds: number[] = data[2];
    this.onBulkAddRecord(data, data[1], rowIds, data[3]);

    // Mark the table as loaded.
    this._isLoaded = true;
  }

  // Used by QuerySet to remove unused rows for onDemand tables when a QuerySet is disposed.
  public unloadPartial(rowIds: number[]): void {
    // Remove the unneeded rows, reusing BulkRemoveRecord code.
    this.onBulkRemoveRecord(['BulkRemoveRecord', this.tableId, rowIds], this.tableId, rowIds);
  }

  /**
   * Read-only tableId.
   */
  public get tableId(): string { return this._tableId; }

  /**
   * Boolean flag for whether the data for this table is already loaded.
   */
  public get isLoaded(): boolean { return this._isLoaded; }

  /**
   * The number of records loaded in this table.
   */
  public numRecords(): number { return this._rowIdCol.length; }

  /**
   * Returns the specified value from this table.
   */
  public getValue(rowId: number, colId: string): CellValue|undefined {
    const colData = this._columns.get(colId);
    const index = this._rowMap.get(rowId);
    return colData && index !== undefined ? colData.values[index] : undefined;
  }

  /**
   * Given a column name, returns a function that takes a rowId and returns the value for that
   * column of that row. The returned function is faster than getValue() calls.
   */
  public getRowPropFunc(colId: string): undefined | ((rowId: number|"new") => CellValue|undefined) {
    const colData = this._columns.get(colId);
    if (!colData) { return undefined; }
    const values = colData.values;
    const rowMap = this._rowMap;
    return function(rowId: number|"new") { return rowId === "new" ? "new" : values[rowMap.get(rowId)!]; };
  }

  /**
   * Returns the list of all rowIds in this table, in unspecified and unstable order. Equivalent
   * to getColValues('id').
   */
  public getRowIds(): ReadonlyArray<number> {
    return this._rowIdCol;
  }

  /**
   * Sort and returns the list of all rowIds in this table.
   */
  public getSortedRowIds(): number[] {
    return this._rowIdCol.slice(0).sort((a, b) => a - b);
  }

  /**
   * Returns the list of colIds in this table, including 'id'.
   */
  public getColIds(): string[] {
    return Array.from(this._columns.keys());
  }

  /**
   * Returns an unsorted list of all values in the given column. With no intervening actions,
   * all arrays returned by getColValues() and getRowIds() are parallel to each other, i.e. the
   * values at the same index correspond to the same record.
   */
  public getColValues(colId: string): ReadonlyArray<CellValue>|undefined {
    const colData = this._columns.get(colId);
    return colData ? colData.values : undefined;
  }

  /**
   * Returns a limited-sized set of distinct values from a column. If count is given, limits how many
   * distinct values are returned.
   */
  public getDistinctValues(colId: string, count: number = Infinity): Set<CellValue>|undefined {
    const valColumn = this.getColValues(colId);
    if (!valColumn) { return undefined; }
    const distinct: Set<CellValue> = new Set();
    // Add values to the set until it reaches the desired size, or until there are no more values.
    for (let i = 0; i < valColumn.length && distinct.size < count; i++) {
      distinct.add(valColumn[i]);
    }
    return distinct;
  }

  /**
   * Return data in TableDataAction form ['TableData', tableId, [...rowIds], {...}]
   */
  public getTableDataAction(): TableDataAction {
    const rowIds = this.getRowIds();
    return ['TableData',
            this.tableId,
            rowIds as number[],
            fromPairs(
              this.getColIds()
                .filter(colId => colId !== 'id')
                .map(colId => [colId, this.getColValues(colId)! as CellValue[]]))];
  }

  /**
   * Returns the given columns type, if the column exists, or undefined otherwise.
   */
  public getColType(colId: string): string|undefined {
    const colData = this._columns.get(colId);
    return colData ? colData.type : undefined;
  }

  /**
   * Builds and returns a record object for the given rowId.
   */
  public getRecord(rowId: number): undefined | RowRecord {
    const index = this._rowMap.get(rowId);
    if (index === undefined) { return undefined; }
    const ret: RowRecord = { id: this._rowIdCol[index] };
    for (const colData of this._colArray) {
      ret[colData.colId] = colData.values[index];
    }
    return ret;
  }

  /**
   * Builds and returns the list of all records on this table, in unspecified and unstable order.
   */
  public getRecords(): RowRecord[] {
    const records: RowRecord[] = this._rowIdCol.map((id) => ({ id }));
    for (const {colId, values} of this._colArray) {
      for (let i = 0; i < records.length; i++) {
        records[i][colId] = values[i];
      }
    }
    return records;
  }

  /**
   * Builds and returns the list of records in this table that match the given properties object.
   * Properties may include 'id' and any table columns. Returned records are not sorted.
   */
  public filterRecords(properties: {[key: string]: any}): RowRecord[] {
    const rowIndices: number[] = [];
    // Pairs of [valueToMatch, arrayOfColValues]
    const props = Object.keys(properties).map(p => [properties[p], this._columns.get(p)]);
    this._rowIdCol.forEach((id, i) => {
      for (const p of props) {
        if (p[1].values[i] !== p[0]) { return; }
      }
      // Collect the indices of the matching rows.
      rowIndices.push(i);
    });

    // Convert the array of indices to an array of RowRecords.
    const records: RowRecord[] = rowIndices.map(i => ({id: this._rowIdCol[i]}));
    for (const {colId, values} of this._colArray) {
      for (let i = 0; i < records.length; i++) {
        records[i][colId] = values[rowIndices[i]];
      }
    }
    return records;
  }

  /**
   * Returns the rowId in the table where colValue is found in the column with the given colId.
   */
  public findRow(colId: string, colValue: any): number {
    const colData = this._columns.get(colId);
    if (!colData) {
      return 0;
    }
    const index = colData.values.indexOf(colValue);
    return index < 0 ? 0 : this._rowIdCol[index];
  }

  /**
   * Applies a DocAction received from the server; returns true, or false if it was skipped.
   */
  public receiveAction(action: DocAction): boolean {
    if (this._isLoaded || isSchemaAction(action)) {
      this.dispatchAction(action);
      return true;
    }
    return false;
  }

  // ---- The following methods implement ActionDispatcher interface ----

  protected onAddRecord(action: DocAction, tableId: string, rowId: number, colValues: ColValues): void {
    const index: number = this._rowIdCol.length;
    this._rowMap.set(rowId, index);
    this._rowIdCol[index] = rowId;
    for (const {colId, defl, values} of this._colArray) {
      values[index] = colValues.hasOwnProperty(colId) ? colValues[colId] : defl;
    }
  }

  protected onBulkAddRecord(action: DocAction, tableId: string, rowIds: number[], colValues: BulkColValues): void {
    const index: number = this._rowIdCol.length;
    for (let i = 0; i < rowIds.length; i++) {
      this._rowMap.set(rowIds[i], index + i);
      this._rowIdCol[index + i] = rowIds[i];
    }
    for (const {colId, defl, values} of this._colArray) {
      for (let i = 0; i < rowIds.length; i++) {
        values[index + i] = colValues.hasOwnProperty(colId) ? colValues[colId][i] : defl;
      }
    }
  }

  protected onRemoveRecord(action: DocAction, tableId: string, rowId: number): void {
    // Note that in this implementation, delete + undo will reorder the storage and the ordering
    // of rows returned getRowIds() and similar methods.
    const index = this._rowMap.get(rowId);
    if (index !== undefined) {
      const last: number = this._rowIdCol.length - 1;
      // We keep the column-wise arrays dense by moving the last element into the freed-up spot.
      for (const {values} of this._columns.values()) {    // This adjusts _rowIdCol too.
        values[index] = values[last];
        values.pop();
      }
      this._rowMap.set(this._rowIdCol[index], index);
      this._rowMap.delete(rowId);
    }
  }

  protected onUpdateRecord(action: DocAction, tableId: string, rowId: number, colValues: ColValues): void {
    const index = this._rowMap.get(rowId);
    if (index !== undefined) {
      for (const colId in colValues) {
        if (colValues.hasOwnProperty(colId)) {
          const colData = this._columns.get(colId);
          if (colData) {
            colData.values[index] = colValues[colId];
          }
        }
      }
    }
  }

  protected onBulkUpdateRecord(action: DocAction, tableId: string, rowIds: number[], colValues: BulkColValues): void {
    for (let i = 0; i < rowIds.length; i++) {
      const index = this._rowMap.get(rowIds[i]);
      if (index !== undefined) {
        for (const colId in colValues) {
          if (colValues.hasOwnProperty(colId)) {
            const colData = this._columns.get(colId);
            if (colData) {
              colData.values[index] = colValues[colId][i];
            }
          }
        }
      }
    }
  }

  protected onReplaceTableData(action: DocAction, tableId: string, rowIds: number[], colValues: BulkColValues): void {
    this.loadData(action as ReplaceTableData);
  }

  protected onAddColumn(action: DocAction, tableId: string, colId: string, colInfo: ColInfo): void {
    if (this._columns.has(colId)) { return; }
    const type = colInfo.type;
    const defl = getDefaultForType(type);
    const colData: ColData = { colId, type, defl, values: this._rowIdCol.map(() => defl) };
    this._columns.set(colId, colData);
    this._colArray.push(colData);
  }

  protected onRemoveColumn(action: DocAction, tableId: string, colId: string): void {
    const colData = this._columns.get(colId);
    if (!colData) { return; }
    this._columns.delete(colId);
    arrayRemove(this._colArray, colData);
  }

  protected onRenameColumn(action: DocAction, tableId: string, oldColId: string, newColId: string): void {
    const colData = this._columns.get(oldColId);
    if (colData) {
      colData.colId = newColId;
      this._columns.set(newColId, colData);
      this._columns.delete(oldColId);
    }
  }

  protected onModifyColumn(action: DocAction, tableId: string, oldColId: string, colInfo: ColInfo): void {
    const colData = this._columns.get(oldColId);
    if (colData && colInfo.hasOwnProperty('type')) {
      colData.type = colInfo.type;
      colData.defl = getDefaultForType(colInfo.type);
    }
  }

  protected onRenameTable(action: DocAction, oldTableId: string, newTableId: string): void {
    this._tableId = newTableId;
  }

  protected onAddTable(action: DocAction, tableId: string, columns: ColInfoWithId[]): void {
    // A table processing its own addition is a noop
  }

  protected onRemoveTable(action: DocAction, tableId: string): void {
    // Stop dispatching actions if we've been deleted. We might also want to clean up in the future.
    this._isLoaded = false;
  }
}

function reassignArray<T>(targetArray: T[], sourceArray: T[]): void {
  targetArray.length = 0;
  arraySplice(targetArray, 0, sourceArray);
}
