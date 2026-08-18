# Time Normalization Helper

## Overview

The `$fn.normalizeTime()` helper function normalizes inconsistent time values into a consistent `hh:mm AM/PM` format. This is especially useful when receiving time data from webhooks or forms where users may enter times in different formats.

## Problem Solved

When webhook payloads contain time values, they often come in inconsistent formats:

- `11:00` (24-hour, no AM/PM)
- `13:00` (24-hour afternoon)
- `1:00 pm` (12-hour, single digit hour)
- `4:00 PM` (12-hour, uppercase)
- `12:30 pm` (12-hour, lowercase)

Without normalization, these values can cause issues when:

- Sending to Google Sheets (inconsistent formatting)
- Forwarding to other APIs expecting a specific format
- Sorting or comparing time values

## Solution

Use `$fn.normalizeTime()` in your expressions to convert any valid time format into a consistent `hh:mm AM/PM` format.

## Usage

### Basic Usage

In any expression field (HTTP Request, Google Sheets, Transform, etc.), wrap your time value with `$fn.normalizeTime()`:

```
{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

### Examples

| Input      | Output     |
| ---------- | ---------- |
| `11:00`    | `11:00 AM` |
| `09:30`    | `09:30 AM` |
| `12:00`    | `12:00 PM` |
| `13:00`    | `01:00 PM` |
| `16:00`    | `04:00 PM` |
| `00:30`    | `12:30 AM` |
| `23:59`    | `11:59 PM` |
| `12:30 pm` | `12:30 PM` |
| `1:00 pm`  | `01:00 PM` |
| `4:00 PM`  | `04:00 PM` |

### Common Use Cases

#### 1. Google Sheets Column

When adding a time column to Google Sheets:

```json
{
  "operation": "append",
  "sheetName": "Bookings",
  "columns": [
    {
      "column": "Preferred Time",
      "value": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}"
    }
  ]
}
```

#### 2. HTTP Request Webhook

When forwarding to another API:

```json
{
  "method": "POST",
  "url": "https://api.example.com/bookings",
  "bodyType": "json",
  "bodyJson": "{\n  \"time\": \"{{ $fn.normalizeTime($json.preferred_time) }}\"\n}"
}
```

#### 3. Transform Step

When cleaning data before processing:

```json
{
  "mode": "onlyDefined",
  "fields": [
    {
      "name": "appointment_time",
      "value": "{{ $fn.normalizeTime($json.time_input) }}",
      "type": "string"
    }
  ]
}
```

#### 4. Email Notification

When including time in an email:

```
Subject: Appointment Confirmed for {{ $fn.normalizeTime($json.time) }}

Body:
Your appointment is scheduled for {{ $fn.normalizeTime($json.preferred_time) }}.
```

## Supported Formats

### 24-Hour Format (Converted to 12-Hour)

- `HH:mm` (e.g., `13:00`, `09:30`, `23:59`)
- Hours: `00` to `23`
- Minutes: `00` to `59`

### 12-Hour Format (Normalized)

- `h:mm AM/PM` or `h:mm am/pm` (e.g., `1:00 pm`, `12:30 PM`)
- Hours: `1` to `12`
- Minutes: `00` to `59`

## Error Handling

The function is designed to fail gracefully:

- **Empty or null values**: Returns empty string `""`
- **Invalid formats**: Returns empty string `""`
- **Invalid ranges**: Returns empty string `""`
  - Hours > 23 (24-hour) or > 12 (12-hour)
  - Minutes > 59

This ensures your workflow continues running even if some time values are missing or malformed.

## Combining with Other Helpers

You can combine `normalizeTime()` with other helpers:

### Force as Text in Google Sheets

```
{{ $fn.text($fn.normalizeTime($json.time)) }}
```

This prevents Google Sheets from re-interpreting the time value.

### Default Value

```
{{ $fn.defaultTo($fn.normalizeTime($json.time), "Not specified") }}
```

Shows "Not specified" if the time is empty or invalid.

## Best Practices

1. **Always normalize webhook times**: If you're receiving time values from external sources, normalize them immediately in your first Transform step.

2. **Use with $fn.text() for Sheets**: When storing normalized times in Google Sheets, wrap with `$fn.text()` to preserve the exact format:

   ```
   {{ $fn.text($fn.normalizeTime($json.time)) }}
   ```

3. **Validate before sending**: Use a Filter step to ensure times are valid before proceeding:

   ```
   Condition: {{ $fn.normalizeTime($json.time) }} is not empty
   ```

4. **Document expected formats**: In webhook documentation or form instructions, specify which time formats are supported.

## Technical Details

- **No timezone conversion**: This function only normalizes the format, it does not convert between timezones
- **Server-side only**: Normalization happens on the server during workflow execution
- **VM-safe**: Runs in the same secure sandbox as other expression helpers
- **Timeout-protected**: Subject to the 250ms expression timeout limit

## Related Helpers

- `$fn.time()` - Formats an ISO date to 12-hour time with timezone conversion
- `$fn.format()` - Advanced date/time formatting with custom patterns
- `$fn.text()` - Forces values to be stored as text in Google Sheets

## Migration Guide

If you were previously using workarounds for time normalization, you can now replace them:

### Before

```
Manually handling different formats in multiple Transform steps
```

### After

```
{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

Single expression that handles all common formats.
