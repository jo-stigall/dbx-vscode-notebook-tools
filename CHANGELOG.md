# Changelog

**Summary:** This file lists what changed in each version of the extension,
newest first.

## Not released

### Documentation

- **A guide to the code of "Visualize Table":**
  [docs/table-viz-how-it-works.md](docs/table-viz-how-it-works.md). It
  follows one request from a click to a chart.
- Each function, component and test helper of the feature has a description.

### Fixed

- **Compare mode stops the queries that nobody needs.** When you change
  dataset B, the queries on the old B stop. When you close a compare card
  before its numbers arrive, its queries stop. Before, these queries
  continued on Databricks and used the places in the queue.
- **Each dataset in compare mode has its own question before a large scan.**
  Before, the board read a large dataset B without a question. If dataset A
  was large, the board showed no question and waited without an end.
- **The identifier card** shows "Fewer than 6" and "7 or more" for lengths
  outside the chart, not "NaN". These rows have no filter button.
- **The partition hint** no longer says that a filter reads all partitions
  when the name of the partition column first occurs inside a longer name.
- **The catalog tree** asks Unity Catalog for catalogs and schemas in pages.
- **Ruff no longer reports "tried to close document that didn't exist"**
  when a notebook file opens. The text document of a file and its notebook
  have the same address, and Ruff keeps one entry for each address. The
  extension now closes the text document before it opens the notebook.
  Before, the two were open at the same time for a moment.
- **The button "Open as Databricks Notebook"** at the top of a text editor
  shows only for a file that starts with `# Databricks notebook source`.
  Before, it showed for each `.py` file.
- **Notebook files with a `# COMMAND ----------` line directly after the
  first line** no longer open with an empty first cell. A save still writes
  the same bytes.
- **"Open SQL in Editor" and "Show SQL"** write each value on one line. A
  value with a line break (from a row of the table or from a
  `.tableviz.json` file) could end its comment line. The rest of the value
  then showed as SQL in the editor, for example as a `DROP TABLE`
  statement. The extension never ran such text.
- **"Cancel" on a SQL warehouse** stops a statement at once when Databricks
  answers a status request with "too many requests" (HTTP 429). Before, the
  cancel had to wait up to 60 seconds for each new try.
- **A cluster connection that you leave** (you select different compute
  while the extension connects) no longer runs the statement that waited
  for it.
- **A "Refresh" that fails** no longer leaves the old numbers in the cache.
  Before, a card that you opened again could show them with no sign that
  they were old.
- **Compare mode:** when you clear "Compare as text" for a column, the
  queries of that column stop.
- **Compare mode:** the text below a drift score gives the real number of
  bins. A column with few different values has fewer than 10.
- **The filter box:** a filter chip that you add while Databricks checks a
  filter stays. Before, the end of the check removed it.
- **Notebook files that start with a byte-order mark** keep the mark when
  you save. Before, the extension removed it, so git showed a change in the
  first line.
- **"Last modified" of a table** is correct when Databricks gives the time
  without a time zone. The board reads such a time as UTC. Before, it used
  the time zone of your computer, so the time could be some hours off.
- **On a cluster, a SQL error that contains the number 401 or 403** (as a
  value or as a position in the statement) shows as the SQL error that it
  is. Before, the extension read the number as "no permission", connected
  again and ran the statement a second time.
- **On a SQL warehouse, a long statement** no longer adds one listener to
  the cancel signal for each status request. Node.js printed a warning in
  the log after 10 of them.
- **Compare mode:** the "Mean A" and "Mean B" cells show "…" while the
  numbers load, as the other cells do. Before, they showed "—".
- **Notebook cells:** if a status request fails, the extension tells the
  cluster to cancel the command. When VS Code stops, it waits for the
  extension to delete the sessions of the open notebooks on the cluster.

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
