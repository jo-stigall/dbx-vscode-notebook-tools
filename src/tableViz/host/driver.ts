/**
 * The Databricks SQL Driver for Node.js, as its own file.
 *
 * The build makes dist/tableViz/driver.js from this file. The extension
 * loads that file when the first statement runs on a cluster. Thus a user
 * who works with SQL warehouses never loads the driver.
 */
export { DBSQLClient, DBSQLParameter, DBSQLParameterType } from '@databricks/sql';
