# Changelog

**Summary:** This file lists what changed in each version of the extension,
newest first.

## 0.2.0 (2026-11-12)

### Added

- **The detailed view of a column.** A click on the row of a column opens a
  view that uses the full width of the board: a row of large numbers (for
  example count, nulls, mean and median), a large chart with a title on
  each axis and a number on each bar, and the tables of the column next to
  the chart. The histogram of a number column has a line at the mean and a
  line at the median. Compare mode has the same view, with the drift score
  at the top.
- **A button on each card** that changes the card from small to detailed and
  back.

### Changed

- **The board keeps the old numbers on the screen while a query runs.**
  Before, the cards and the table became empty after each new filter and
  each "Refresh". Now the old numbers stay, dimmed, until the new numbers
  arrive, and a thin line at the top of a card shows that a query runs.
- **Charts move.** When the numbers change, the bars move to their new
  heights. A new card and a new filter chip fade in. The page moves to the
  card that you opened. The board shows no animation if your operating
  system is set to "reduce motion".
- **A new card opens as the detailed view.** A pinned card becomes small, so
  that pinned cards still sit side by side.
- **The full row of the overview opens the column,** not only the name.
- A saved view of version 0.1.0 opens as before. Its cards are small.

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
