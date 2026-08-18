# Quick Start: Fix Your Time Field

## The Problem You Had

Your webhook receives `preferred_time_only` with inconsistent formats:

- `11:00`
- `12:30 pm`
- `1:00 pm`
- `4:00 PM`
- `13:00`

This caused Google Sheets or HTTP requests to fail or skip entries.

## The Solution

Use the new `$fn.normalizeTime()` helper in your expression.

## How to Fix It

### Option 1: Direct in Google Sheets Step

In your Google Sheets "Add Row" or "Update Row" step:

**Before:**

```
{{ $trigger.body.preferred_time_only }}
```

**After:**

```
{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

**Complete Example:**

```json
{
  "operation": "append",
  "sheetName": "Sheet1",
  "headerRow": 1,
  "columns": [
    {
      "column": "Name",
      "value": "{{ $trigger.body.name }}"
    },
    {
      "column": "Email",
      "value": "{{ $trigger.body.email }}"
    },
    {
      "column": "Preferred Time",
      "value": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}"
    }
  ]
}
```

### Option 2: Using Transform Step (Recommended)

Add a Transform step right after your webhook trigger to clean all fields:

1. Add a **Transform** step after your Webhook Trigger
2. Set mode to "Only defined fields"
3. Add these fields:

```json
{
  "mode": "onlyDefined",
  "fields": [
    {
      "name": "name",
      "value": "{{ $fn.title($trigger.body.name) }}",
      "type": "string"
    },
    {
      "name": "email",
      "value": "{{ $fn.lower($fn.trim($trigger.body.email)) }}",
      "type": "string"
    },
    {
      "name": "preferred_time",
      "value": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}",
      "type": "string"
    }
  ]
}
```

4. Then in your Google Sheets step, reference the cleaned data:

```json
{
  "columns": [
    { "column": "Name", "value": "{{ $json.name }}" },
    { "column": "Email", "value": "{{ $json.email }}" },
    { "column": "Preferred Time", "value": "{{ $json.preferred_time }}" }
  ]
}
```

### Option 3: In HTTP Request Step

If forwarding to another webhook:

**Before:**

```json
{
  "method": "POST",
  "url": "https://your-api.com/webhook",
  "bodyType": "json",
  "bodyJson": "{\n  \"time\": \"{{ $trigger.body.preferred_time_only }}\"\n}"
}
```

**After:**

```json
{
  "method": "POST",
  "url": "https://your-api.com/webhook",
  "bodyType": "json",
  "bodyJson": "{\n  \"time\": \"{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}\"\n}"
}
```

## What You'll Get

All these different inputs:

- `11:00` → `11:00 AM`
- `12:30 pm` → `12:30 PM`
- `1:00 pm` → `01:00 PM`
- `4:00 PM` → `04:00 PM`
- `13:00` → `01:00 PM`

Will now be consistently formatted as `hh:mm AM/PM`

## Prevent Google Sheets from Re-Interpreting

If Google Sheets still tries to convert your time to its own format, use `$fn.text()`:

```
{{ $fn.text($fn.normalizeTime($trigger.body.preferred_time_only)) }}
```

This adds a leading apostrophe (invisible in the cell) that tells Sheets to keep it as plain text.

## Testing

1. Open your workflow
2. Find the field where you use `{{ $trigger.body.preferred_time_only }}`
3. Replace it with `{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}`
4. Save the workflow
5. Test with a sample webhook payload

## Error Handling

If the time value is missing or invalid, the function returns an empty string instead of crashing your workflow. This means:

- Workflow continues running
- Other fields still get processed
- You can add a Filter step to catch empty times if needed

## Example Filter (Optional)

To skip entries with invalid times:

1. Add a **Filter** step after your Transform
2. Set condition: `{{ $json.preferred_time }}` → `is not empty`

This ensures only valid, normalized times proceed to Google Sheets.

---

## Quick Reference

| Your Use Case        | Expression                                                             |
| -------------------- | ---------------------------------------------------------------------- |
| Google Sheets column | `{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}`           |
| With text protection | `{{ $fn.text($fn.normalizeTime($trigger.body.preferred_time_only)) }}` |
| HTTP request body    | Same as above                                                          |
| Transform field      | Same as above                                                          |
| From previous step   | `{{ $fn.normalizeTime($json.time_field) }}`                            |

## Need More Help?

See the full documentation: `docs/TIME-NORMALIZATION.md`
