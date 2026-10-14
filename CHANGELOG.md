# Changelog

## 1.1.0 (2026-10-14)

Added

- **Data rows.** Paste rows from Excel or Google Sheets, or load a `.csv`, match the columns to fields, and fill one row per press of Fill. The profile remembers which row is next.
- **A check of the data** before filling: cells the page will not accept (unknown picklist value, bad email, text in a number or date field, blank in a required field) are listed and marked in the table.
- **Ask at fill time.** `{{ask:Label}}` prompts for a value on every fill, in the panel or on the page itself for shortcut fills.
- **My details.** Personal values used as `{{my.email}}` and the like. They stay on the PC and are never exported.
- **Undo.** Restores every field the last fill changed, from the report or with Alt+Shift+U.
- **Pre-save check.** Every fill report lists the required fields that are still empty.
- A **{ }** menu on each row for inserting these values.
- An `examples` folder with a demo form and sample spreadsheets, and an end-to-end test suite in `tests`.

Changed

- Redesigned side panel: tabbed editor, clearer rows with a "required" marker, a fill report with clickable field names, a Selectors toggle, and colours taken from the icon.
- A value the page marks as invalid (wrong email format, too long, pattern mismatch) is now reported with the page's own reason instead of counting as a clean fill.
- A tick box given something other than yes or no says so plainly.
- Fill reports are cleared when the page reloads, since they no longer describe it.
- Exports no longer include data rows or the answers last typed in.

## 1.0.0 (2026-10-14)

First release.

- Scan a page into a sheet of Label, Selector and Value rows
- Save sheets as profiles, matched to pages by URL pattern
- Fill from the side panel or with Alt+Shift+F
- Fills text boxes, picklists, multi-selects, checkboxes, radio groups and rich-text boxes, including Select2 dropdowns, iframes and shadow DOM
- Pick a field by clicking it, or paste a selector, JS path, XPath or outerHTML from DevTools
- Grab the values currently on the page into the sheet
- `{{today}}` and `{{clear}}` special values
- Import and export profiles as JSON
