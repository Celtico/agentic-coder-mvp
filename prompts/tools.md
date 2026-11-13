# Descripcions de les eines

Cada secció «## nom» és la descripció que rep el model d’aquella eina (els noms i els paràmetres són al codi).
Una secció buida o que no hi és vol dir que l’eina s’envia sense descripció.

## list_files
List the files in the selected project.

## delegate_tasks
Delegate up to three independent subtasks to specialist coding agents. Each agent uses the same local model and selected project, works sequentially to share the model safely, and returns its findings or changes. Use only for tasks that benefit from splitting; never delegate the same file or overlapping edits twice.

## read_file
Read a visible text file in the selected project.

## search_text
Search text in project files.

## call_mcp_tool
Call a tool of one of the MCP servers this project declares in mcp.json (for example a component library's own documentation). Use the server and tool names listed in the instructions.

## read_web_page
Read the text of one public web page: a search result, or documentation the user named. Returns the page text, cut to a few thousand characters.

## web_search
Search the public web for current or external information when it is useful. Send only a short general query; never include private project code, file contents, secrets, or personal data.

## write_file
Create or update a text file inside the selected project. Normal edits are applied and backed up automatically.

## delete_file
Delete a normal project file after saving a recoverable copy outside the project.

## run_tests
Run the configured project test script.

## run_project_script
Run an existing script from package.json.

## start_project
Start the existing dev, start, or preview project script. If it prints a localhost URL, the app opens it in the integrated browser.

## stop_project
Stop the running project process.

## create_git_commit
Create a Git commit in the selected project when the user has requested it.

## install_dependencies
Install everything package.json lists (npm install). Use it after writing or changing package.json, before starting the project.

## run_npx
Run the command-line tool of an npm package inside the project, as installation guides ask for: `npx <packageName> <args>`. Example: packageName "<package>", args ["<command>", "<argument>"].

## install_package
Install one npm package by name.

## inspect_browser
Inspect a running local development page. Optionally click, fill, or check visible UI elements. Only local URLs are allowed; no arbitrary selectors or JavaScript.
