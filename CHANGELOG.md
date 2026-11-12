# Changelog

**Summary:** This file lists what changed in each version of the extension,
newest first.

## 0.1.0 (2026-11-12)

### Added

- **Visualize Table.** A page that shows each column of a Databricks table:
  type, percent null, distinct count and a small chart. Databricks computes
  all numbers; the extension never downloads the rows of a table.
- **Detail cards** for each kind of column: a histogram and statistics for a
  number, bars and a frequency table for a category, counts over time for a
  date, and repeated values and value lengths for an ID.
- **Compare mode.** Put a second dataset next to the first one: two tables,
  one table under two filters, or one table at two Delta versions. The board
  shows which columns differ and ranks the columns by a drift score.
- **Filters.** Type a SQL condition, or click a bar of a chart. Read a sample
  of the rows for a fast first look.
- **Export.** Save a chart as PNG or SVG, save the tables of a card as CSV,
  and open the SQL of a card in an editor.
- **Saved views.** "Save View" writes the board to a `.tableviz.json` file
  that has no data and no token. Open the file to get the board again.
- **The view "Databricks Tables"** in the Explorer: catalogs, schemas and
  tables, with favorites and recent tables.
- **Select Profile and Compute for Tables.** Use a profile of
  `~/.databrickscfg`, the connection of the notebooks, or a workspace URL
  and a token. Run the queries on a SQL warehouse or an all-purpose cluster.
- **A Demo profile** with two demo tables. It needs no workspace.

### Changed

- To build the install file, you now need Node.js 22 or later. Run
  `npm install`, then `npm run package`. A computer that only installs the
  `.vsix` file does not need Node.js.
- The notebook part of the extension did not change. Its tests pass without
  a change.

### Not verified

- No part of "Visualize Table" has run on a real Databricks workspace. See
  the README.
