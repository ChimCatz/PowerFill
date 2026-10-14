# Changelog

## 1.2.1 (2026-10-14)

- New logo: an orange P with a lightning bolt. It is the toolbar and extension icon, the mark in the panel header, and the README banner. Source files are in `docs/logo/`.

## 1.2.0 (2026-10-14)

From the team's first round of testing.

Added

- **Move fields.** Drag a row by its handle, or use the Up and Down arrow keys on the handle. Fields are filled in sheet order.
- **Search in picklists.** Picklists in the sheet, and the column matching in Data rows, open a list with a search box at the top. A value that is not on the list can be typed and used.
- **Recent values.** The values last chosen for a field are pinned at the top of its picklist and suggested in its text box. They are kept per field of a site, so every profile for that form shares them.
- **Scrolling scan.** "Scroll the page to find every field" scrolls the page before scanning, for fields that load or appear further down. It only scrolls, stops when the page is touched or Stop is pressed, has a 20-second limit, and restores the scroll position.
- `{{ask:…}}` questions about a picklist suggest its options and recent answers.

Fixed

- A profile with a long page address pushed its Fill button out of a narrow panel. Every screen is now checked from 300px to 1400px wide.
- Fields that a page fades in on scroll were skipped by the scan until they had been scrolled into view; the scrolling scan now finds them.

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
