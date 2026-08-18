# How to Use $fn.normalizeTime() - Step by Step

## Step 1: Open Your Workflow

1. Go to the Workflows page
2. Click on the workflow that receives the time field
3. You should see your workflow canvas with nodes

## Step 2: Find Where You Use the Time Field

Look for nodes that reference `preferred_time_only` or your time field. Common places:

### A. Google Sheets Node

- Click on your Google Sheets node
- Look at the "Columns" section
- Find the column that has the time value

### B. HTTP Request Node

- Click on your HTTP Request node
- Look at the "Body" section
- Find where the time field is referenced

### C. Transform Node

- Click on your Transform node
- Look at the "Fields" section
- Find the field definition with the time

## Step 3: Edit the Expression

### Current Expression (what you have now):

```
{{ $trigger.body.preferred_time_only }}
```

### New Expression (what to change it to):

```
{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

### How to Edit:

1. **In Google Sheets Node:**
   - Click the column that shows the time
   - In the "Value" field, you'll see the current expression
   - Wrap it with `$fn.normalizeTime(...)`
   - Example:
     ```
     Before: {{ $trigger.body.preferred_time_only }}
     After:  {{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
     ```

2. **In HTTP Request Node:**
   - Click "Edit" on the body
   - Find the time field in the JSON
   - Wrap the expression with `$fn.normalizeTime(...)`
   - Example:
     ```json
     Before: { "time": "{{ $trigger.body.preferred_time_only }}" }
     After:  { "time": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}" }
     ```

3. **In Transform Node:**
   - Click the field that handles time
   - In the "Value" expression field, wrap with `$fn.normalizeTime(...)`
   - Example:
     ```
     Before: {{ $trigger.body.preferred_time_only }}
     After:  {{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
     ```

## Step 4: Save the Workflow

1. Click "Save" or press Ctrl+S (Cmd+S on Mac)
2. Wait for the success message

## Step 5: Test It

### Option A: Use Test Mode

1. If your workflow has a "Test" button, click it
2. Provide sample data with different time formats:
   ```json
   {
     "preferred_time_only": "13:00"
   }
   ```
3. Check the output - should show `01:00 PM`

### Option B: Send Real Webhook

1. Trigger your webhook with real data
2. Go to the "Runs" page
3. Click on the latest run
4. Check the node output - time should be normalized

## Common Scenarios

### Scenario 1: Simple Google Sheets Column

**Node:** Google Sheets → Append Row

**Field to Change:**

- Column name: "Preferred Time"
- Old value: `{{ $trigger.body.preferred_time_only }}`
- New value: `{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}`

**Steps:**

1. Open Google Sheets node
2. Find "Preferred Time" in columns list
3. Click the value field
4. Update the expression
5. Save

### Scenario 2: HTTP Request with JSON Body

**Node:** HTTP Request

**Field to Change:**

- Body type: JSON
- Find the time field in the JSON editor

**Steps:**

1. Open HTTP Request node
2. Scroll to "Body" section
3. Find the line with your time field
4. Update like this:
   ```json
   {
     "appointment": {
       "time": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}"
     }
   }
   ```
5. Save

### Scenario 3: Transform Then Google Sheets (Recommended)

**Best Practice Flow:**

```
Webhook Trigger → Transform → Google Sheets
```

**Steps:**

1. **Add Transform Node (if you don't have one):**
   - Click "+" or drag "Transform" from palette
   - Place it between Trigger and Google Sheets
   - Connect with edges

2. **Configure Transform Node:**
   - Mode: "Only defined fields"
   - Click "Add Field"
   - Field name: `preferred_time`
   - Value: `{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}`
   - Type: `string`
   - Save

3. **Update Google Sheets Node:**
   - Change the column value from:
     `{{ $trigger.body.preferred_time_only }}`
   - To:
     `{{ $json.preferred_time }}`
   - (Now it uses the cleaned data from Transform)

## Visual Reference

```
┌─────────────────────┐
│  Webhook Trigger    │
│  Body received:     │
│  preferred_time_only│
└──────────┬──────────┘
           │
           ↓
┌─────────────────────────────────────────────────┐
│  Transform (optional but recommended)           │
│  ────────────────────────────────────          │
│  Field: preferred_time                          │
│  Value: {{ $fn.normalizeTime(                  │
│           $trigger.body.preferred_time_only)    │
│         }}                                      │
└──────────┬──────────────────────────────────────┘
           │
           ↓
┌─────────────────────────────────────────────────┐
│  Google Sheets / HTTP Request                   │
│  ────────────────────────────────────          │
│  Use: {{ $json.preferred_time }}                │
│  Result: "01:00 PM" (normalized)                │
└─────────────────────────────────────────────────┘
```

## Quick Copy-Paste Examples

### For Google Sheets Column Value:

```
{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

### For HTTP Request JSON Body:

```json
{
  "time": "{{ $fn.normalizeTime($trigger.body.preferred_time_only) }}"
}
```

### For Transform Field:

```
Field name: preferred_time
Value: {{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
Type: string
```

### For Email Subject/Body:

```
Appointment at {{ $fn.normalizeTime($trigger.body.preferred_time_only) }}
```

## Troubleshooting

### ❌ Still seeing inconsistent times?

**Check:**

- Did you save the workflow?
- Is the expression wrapped correctly?
- Try refreshing the page

### ❌ Getting empty values?

**Check:**

- Is the field name correct? (`$trigger.body.preferred_time_only`)
- Does the incoming data actually have this field?
- Look at a Run log to see what data arrived

### ❌ Expression error?

**Check:**

- Matching brackets: `{{ ... }}`
- Matching parentheses: `normalizeTime(...)`
- No typos in function name: `normalizeTime` (not `normalizedate` or `normalizetime`)

## Testing Different Input Formats

Send these test webhooks to verify it works:

```bash
# Test 1: 24-hour morning
curl -X POST https://your-webhook-url \
  -H "Content-Type: application/json" \
  -d '{"preferred_time_only": "11:00"}'
# Expected: "11:00 AM"

# Test 2: 24-hour afternoon
curl -X POST https://your-webhook-url \
  -H "Content-Type: application/json" \
  -d '{"preferred_time_only": "13:00"}'
# Expected: "01:00 PM"

# Test 3: 12-hour with pm
curl -X POST https://your-webhook-url \
  -H "Content-Type: application/json" \
  -d '{"preferred_time_only": "4:00 PM"}'
# Expected: "04:00 PM"
```

## Where to Check Results

After running the workflow:

1. **In Run Logs:**
   - Go to "Runs" page
   - Click on the latest run
   - Expand each node to see its output
   - Look for your time field - should show normalized format

2. **In Google Sheets:**
   - Open your spreadsheet
   - Check the "Preferred Time" column
   - All times should now be in `hh:mm AM/PM` format

3. **In HTTP Response (if forwarding):**
   - Check the receiving API logs
   - Time should be consistently formatted

## Summary Checklist

- [ ] Located the node that uses the time field
- [ ] Found the expression with `preferred_time_only`
- [ ] Wrapped it with `$fn.normalizeTime(...)`
- [ ] Saved the workflow
- [ ] Tested with sample data
- [ ] Verified the output is in `hh:mm AM/PM` format
- [ ] Checked Google Sheets / destination API

---

**Need Help?**

- See full docs: `docs/TIME-NORMALIZATION.md`
- See examples: `QUICK-START-TIME-FIX.md`
- See what changed: `CHANGES-SUMMARY.md`
