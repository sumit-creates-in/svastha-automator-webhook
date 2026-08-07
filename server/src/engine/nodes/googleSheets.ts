import axios from 'axios';
import { describeGoogleError, getGoogleAccessToken } from '../../lib/google';
import type { NodeDefinition } from '../types';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Accepts a full share URL or a bare id, because people paste the URL. */
export function extractSpreadsheetId(value: string): string {
  const trimmed = String(value ?? '').trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return trimmed.replace(/^\/+|\/+$/g, '');
}

function quoteSheet(name: string): string {
  const clean = String(name ?? 'Sheet1').trim() || 'Sheet1';
  return /^[A-Za-z0-9_]+$/.test(clean) ? clean : `'${clean.replace(/'/g, "''")}'`;
}

interface ColumnRow {
  column?: string;
  value?: unknown;
  format?: string;
}

/**
 * Applies the per-column format.
 *
 * Google Sheets parses whatever it is given: `2:50 pm` becomes a time value,
 * `919876543210` can be shown in scientific notation, and a leading `+` or `0`
 * is silently dropped. A leading apostrophe is the spreadsheet convention for
 * "store this exactly as typed" — it is not shown in the cell.
 */
export function formatCell(value: unknown, format = 'auto'): unknown {
  if (value === null || value === undefined) return '';

  switch (format) {
    case 'text':
      return forceText(value);
    case 'phone': {
      const digits = String(value).replace(/\D/g, '');
      return digits ? forceText(digits) : '';
    }
    case 'number': {
      const parsed = Number(String(value).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(parsed) ? parsed : '';
    }
    case 'auto':
    default:
      return value;
  }
}

function forceText(value: unknown): string {
  const text = String(value);
  return text === '' || text.startsWith("'") ? text : `'${text}`;
}

/** Turns the mapping rows into a header-aligned array for the Sheets API. */
export function buildRow(
  headers: string[],
  mappings: ColumnRow[],
  defaultFormat = 'auto',
): { values: unknown[]; unmatched: string[] } {
  const byName = new Map<string, ColumnRow>();
  for (const row of mappings) {
    if (row?.column) byName.set(String(row.column).trim().toLowerCase(), row);
  }

  const values = headers.map((header) => {
    const key = header.trim().toLowerCase();
    const row = byName.get(key);
    byName.delete(key);
    if (!row) return '';
    return formatCell(row.value ?? '', row.format && row.format !== 'inherit' ? row.format : defaultFormat);
  });

  return { values, unmatched: [...byName.keys()] };
}

export const googleSheets: NodeDefinition = {
  type: 'googleSheets',
  displayName: 'Google Sheets',
  group: 'action',
  version: 1,
  description:
    'Add rows to a spreadsheet, read them back, update a row, or clear a range. Column names are matched to your data, so nobody has to think about cell references.',
  icon: 'Table2',
  color: '#0f9d58',
  inputs: 1,
  outputs: [{ name: 'main', label: 'Output' }],
  properties: [
    {
      name: 'connection',
      label: 'Google account',
      type: 'connection',
      connectionType: 'googleServiceAccount,googleOAuth2',
      required: true,
      description: 'Set this up once under Connections.',
    },
    {
      name: 'operation',
      label: 'What should happen?',
      type: 'select',
      default: 'append',
      required: true,
      options: [
        { label: 'Add a new row', value: 'append' },
        { label: 'Read rows', value: 'read' },
        { label: 'Update an existing row', value: 'update' },
        { label: 'Clear a range', value: 'clear' },
      ],
    },
    {
      name: 'spreadsheetId',
      label: 'Spreadsheet',
      type: 'string',
      required: true,
      placeholder: 'https://docs.google.com/spreadsheets/d/1AbC.../edit',
      description: 'Paste the whole share link or just the id — either works.',
    },
    {
      name: 'sheetName',
      label: 'Tab name',
      type: 'string',
      default: 'Sheet1',
      required: true,
      description: 'The tab along the bottom of the spreadsheet. Case-sensitive.',
    },
    {
      name: 'headerRow',
      label: 'Header row number',
      type: 'number',
      default: 1,
      description: 'The row containing your column titles.',
      displayOptions: { show: { operation: ['append', 'update'] } },
    },
    {
      name: 'columns',
      label: 'Columns to write',
      type: 'collection',
      default: [{ column: '', value: '' }],
      description:
        'Type the column title exactly as it appears in the sheet, then pick the value from Available Fields.',
      fields: [
        { name: 'column', label: 'Column title', type: 'string', placeholder: 'Email' },
        { name: 'value', label: 'Value', type: 'string', placeholder: '{{ $json.body.email }}' },
        {
          name: 'format',
          label: 'Store as',
          type: 'select',
          default: 'inherit',
          options: [
            { label: 'Default', value: 'inherit' },
            { label: 'Text — exactly as written', value: 'text' },
            { label: 'Phone number', value: 'phone' },
            { label: 'Number', value: 'number' },
            { label: 'Let Sheets decide', value: 'auto' },
          ],
        },
      ],
      displayOptions: { show: { operation: ['append', 'update'] } },
    },
    {
      name: 'defaultFormat',
      label: 'Default for every column',
      type: 'select',
      default: 'text',
      options: [
        {
          label: 'Text — keep values exactly as written (recommended)',
          value: 'text',
          description:
            'Stops Sheets turning "2:50 pm" into a time value or mangling phone numbers.',
        },
        {
          label: 'Let Sheets decide',
          value: 'auto',
          description: 'Numbers, dates and times are parsed. Use when you need to do sums.',
        },
      ],
      description: 'Individual columns can override this above.',
      displayOptions: { show: { operation: ['append', 'update'] } },
    },
    {
      name: 'matchColumn',
      label: 'Find the row where this column…',
      type: 'string',
      placeholder: 'Email',
      description: 'The column used to locate the row to update.',
      displayOptions: { show: { operation: ['update'] } },
    },
    {
      name: 'matchValue',
      label: '…equals this value',
      type: 'string',
      placeholder: '{{ $json.body.email }}',
      displayOptions: { show: { operation: ['update'] } },
    },
    {
      name: 'createIfMissing',
      label: 'Add a new row if no match is found',
      type: 'boolean',
      default: true,
      displayOptions: { show: { operation: ['update'] } },
    },
    {
      name: 'range',
      label: 'Range',
      type: 'string',
      default: 'A1:Z1000',
      description: 'For example A1:D50. Leave the default to cover the whole sheet.',
      displayOptions: { show: { operation: ['read', 'clear'] } },
    },
    {
      name: 'firstRowIsHeader',
      label: 'First row contains column titles',
      type: 'boolean',
      default: true,
      description: 'On: rows come back as named fields instead of A, B, C.',
      displayOptions: { show: { operation: ['read'] } },
    },
    {
      name: 'notice',
      label: 'Using a service account?',
      type: 'notice',
      description:
        'Share the spreadsheet with the service account email address and give it Editor access, otherwise Google will refuse with a permission error.',
    },
  ],

  async execute(ctx) {
    const params = ctx.params as Record<string, any>;
    if (!params.connection) throw new Error('Choose a Google account connection');

    const credential = await ctx.getConnection(String(params.connection));
    const token = await getGoogleAccessToken(credential);

    const spreadsheetId = extractSpreadsheetId(String(params.spreadsheetId ?? ''));
    if (!spreadsheetId) throw new Error('Paste the spreadsheet link or id');

    const sheet = quoteSheet(params.sheetName ?? 'Sheet1');
    const operation = String(params.operation ?? 'append');

    const client = axios.create({
      baseURL: `${API}/${spreadsheetId}`,
      headers: { Authorization: `Bearer ${token}` },
      // Sheets is regularly slower than a second; generous but bounded.
      timeout: 60000,
      signal: ctx.signal,
    });

    try {
      if (operation === 'read') {
        const range = `${sheet}!${params.range ?? 'A1:Z1000'}`;
        const { data } = await client.get(`/values/${encodeURIComponent(range)}`);
        const rows: string[][] = data.values ?? [];

        if (params.firstRowIsHeader === false || rows.length === 0) {
          ctx.log(`Read ${rows.length} rows`);
          return { kind: 'output', data: { rows, count: rows.length } };
        }

        const [headers, ...body] = rows;
        const items = body.map((row) => {
          const record: Record<string, unknown> = {};
          headers.forEach((header, index) => {
            record[header || `column${index + 1}`] = row[index] ?? '';
          });
          return record;
        });

        ctx.log(`Read ${items.length} rows`);
        return { kind: 'output', data: { items, count: items.length, headers } };
      }

      if (operation === 'clear') {
        const range = `${sheet}!${params.range ?? 'A1:Z1000'}`;
        await client.post(`/values/${encodeURIComponent(range)}:clear`, {});
        ctx.log(`Cleared ${range}`);
        return { kind: 'output', data: { cleared: true, range } };
      }

      // append / update both need the header row to align the columns.
      const headerRowNumber = Number(params.headerRow ?? 1);
      const headerRange = `${sheet}!${headerRowNumber}:${headerRowNumber}`;
      const headerResponse = await client.get(`/values/${encodeURIComponent(headerRange)}`);
      const headers: string[] = headerResponse.data.values?.[0] ?? [];

      if (headers.length === 0) {
        throw new Error(
          `Row ${headerRowNumber} of "${params.sheetName}" is empty, so there are no column titles to match. Add a header row, or change "Header row number".`,
        );
      }

      const mappings = Array.isArray(params.columns) ? (params.columns as ColumnRow[]) : [];
      const { values, unmatched } = buildRow(
        headers,
        mappings,
        String(params.defaultFormat ?? 'text'),
      );

      if (unmatched.length > 0) {
        ctx.log(
          `Warning: no column titled ${unmatched
            .map((name) => `"${name}"`)
            .join(', ')} — those values were not written. Sheet columns: ${headers.join(', ')}`,
        );
      }

      if (operation === 'append') {
        const range = `${sheet}!A${headerRowNumber}`;
        const { data } = await client.post(
          `/values/${encodeURIComponent(range)}:append`,
          { values: [values] },
          {
            params: {
              valueInputOption: 'USER_ENTERED',
              insertDataOption: 'INSERT_ROWS',
              includeValuesInResponse: false,
            },
          },
        );

        const updatedRange = data.updates?.updatedRange ?? '';
        ctx.log(`Added a row at ${updatedRange}`);
        return {
          kind: 'output',
          data: {
            success: true,
            operation: 'append',
            updatedRange,
            updatedRows: data.updates?.updatedRows ?? 1,
            spreadsheetId,
            unmatchedColumns: unmatched,
          },
        };
      }

      // update
      const matchColumn = String(params.matchColumn ?? '').trim();
      if (!matchColumn) throw new Error('Choose the column used to find the row');
      const columnIndex = headers.findIndex(
        (header) => header.trim().toLowerCase() === matchColumn.toLowerCase(),
      );
      if (columnIndex === -1) {
        throw new Error(
          `There is no column titled "${matchColumn}". The sheet has: ${headers.join(', ')}`,
        );
      }

      const searchRange = `${sheet}!A${headerRowNumber + 1}:Z100000`;
      const searchResponse = await client.get(`/values/${encodeURIComponent(searchRange)}`);
      const existing: string[][] = searchResponse.data.values ?? [];
      const target = String(params.matchValue ?? '');

      const offset = existing.findIndex(
        (row) => String(row[columnIndex] ?? '').trim().toLowerCase() === target.trim().toLowerCase(),
      );

      if (offset === -1) {
        if (params.createIfMissing === false) {
          throw new Error(`No row found where "${matchColumn}" is "${target}"`);
        }
        const { data } = await client.post(
          `/values/${encodeURIComponent(`${sheet}!A${headerRowNumber}`)}:append`,
          { values: [values] },
          { params: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' } },
        );
        ctx.log(`No existing row matched — added a new one`);
        return {
          kind: 'output',
          data: {
            success: true,
            operation: 'append',
            created: true,
            updatedRange: data.updates?.updatedRange ?? '',
            spreadsheetId,
          },
        };
      }

      const rowNumber = headerRowNumber + 1 + offset;
      const writeRange = `${sheet}!A${rowNumber}`;
      const { data } = await client.put(
        `/values/${encodeURIComponent(writeRange)}`,
        { values: [values] },
        { params: { valueInputOption: 'USER_ENTERED' } },
      );

      ctx.log(`Updated row ${rowNumber}`);
      return {
        kind: 'output',
        data: {
          success: true,
          operation: 'update',
          created: false,
          row: rowNumber,
          updatedRange: data.updatedRange ?? writeRange,
          spreadsheetId,
          unmatchedColumns: unmatched,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error) || (error as { response?: unknown })?.response) {
        throw new Error(`Google Sheets: ${describeGoogleError(error)}`);
      }
      throw error;
    }
  },
};

export default googleSheets;
