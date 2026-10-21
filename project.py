<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#1e1e1e">

    <title>CodeSpace - Code Editor</title>

    <script src="https://cdn.tailwindcss.com"></script>

    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        vscode: {
                            bg: "#1e1e1e",
                            sidebar: "#181818",
                            activity: "#181818",
                            panel: "#252526",
                            tab: "#2d2d2d",
                            border: "#333333",
                            muted: "#858585",
                            blue: "#007acc",
                            status: "#007acc"
                        }
                    }
                }
            }
        };
    </script>

    <style>
        html, body {
            height: 100%;
            margin: 0;
            overflow: hidden;
            background: #1e1e1e;
        }

        * {
            box-sizing: border-box;
        }

        .editor-font {
            font-family: Consolas, "Courier New", monospace;
            font-size: 13px;
            font-weight: 400;
            line-height: 22px;
            tab-size: 4;
        }

        .editor-scroll {
            scrollbar-width: thin;
            scrollbar-color: #424242 transparent;
        }

        .editor-scroll::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        .editor-scroll::-webkit-scrollbar-thumb {
            background: #424242;
        }

        .activity-button {
            position: relative;
            color: #858585;
            transition: color 150ms ease;
        }

        .activity-button:hover {
            color: #ffffff;
        }

        .activity-button.active {
            color: #ffffff;
        }

        .activity-button.active::before {
            content: "";
            position: absolute;
            left: 0;
            top: 7px;
            bottom: 7px;
            width: 2px;
            background: #ffffff;
        }

        .file-row {
            color: #cccccc;
            transition: background 120ms ease;
        }

        .file-row:hover {
            background: #2a2d2e;
        }

        .file-row.active {
            background: #37373d;
            color: #ffffff;
        }

        .editor-tab {
            position: relative;
            background: #2d2d2d;
            color: #969696;
            border-right: 1px solid #252526;
        }

        .editor-tab.active {
            background: #1e1e1e;
            color: #ffffff;
        }

        .editor-tab.active::before {
            content: "";
            position: absolute;
            height: 1px;
            background: #007acc;
            top: 0;
            left: 0;
            right: 0;
        }

        .syntax-keyword {
            color: #569cd6;
        }

        .syntax-string {
            color: #ce9178;
        }

        .syntax-comment {
            color: #6a9955;
        }

        .syntax-function {
            color: #dcdcaa;
        }

        .syntax-tag {
            color: #569cd6;
        }

        .syntax-attribute {
            color: #9cdcfe;
        }

        .syntax-value {
            color: #ce9178;
        }

        .syntax-number {
            color: #b5cea8;
        }

        .syntax-selector {
            color: #d7ba7d;
        }

        .syntax-property {
            color: #9cdcfe;
        }

        .syntax-operator {
            color: #d4d4d4;
        }

        .editor-line {
            display: block;
            min-height: 22px;
            white-space: pre;
            padding-right: 30px;
        }

        .editor-line.current {
            background: #282828;
        }

        .line-number {
            display: inline-block;
            width: 52px;
            padding-right: 17px;
            text-align: right;
            color: #858585;
            user-select: none;
            flex-shrink: 0;
        }

        #codeInput {
            resize: none;
            outline: none;
            border: none;
            background: transparent;
            color: #d4d4d4;
            caret-color: #ffffff;
            white-space: pre;
            overflow: auto;
            tab-size: 4;
        }

        #highlightLayer {
            pointer-events: none;
            white-space: pre;
        }

        .code-line {
            min-height: 22px;
        }

        .status-item {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 0 8px;
            height: 22px;
            white-space: nowrap;
        }

        .status-item:hover {
            background: rgba(255, 255, 255, 0.12);
        }

        .sidebar-transition {
            transition: width 160ms ease;
        }

        @media (max-width: 640px) {
            .line-number {
                width: 38px;
                padding-right: 10px;
            }

            .editor-font {
                font-size: 12px;
            }

            #welcomeText {
                display: none;
            }
        }
    </style>
</head>

<body class="text-gray-200 antialiased">

<div id="app" class="flex flex-col h-screen w-screen">

    <!-- TITLE BAR -->

    <header class="h-10 flex items-center justify-between bg-[#181818] border-b border-[#333] shrink-0 select-none">

        <div class="flex items-center h-full min-w-0">

            <div class="flex items-center justify-center w-12 h-full text-[#29b6f6]">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.5 2 7 12l10.5 10 5-2V4l-5-2ZM7 12 2 7l3-2 5 4-3 3Zm0 0-5 5 3 2 5-4-3-3Z"/>
                </svg>
            </div>

            <button id="toggleExplorerTop"
                class="px-3 h-full text-xs text-gray-400 hover:bg-[#2a2d2e] hover:text-white">
                File
            </button>

            <span id="welcomeText" class="text-xs text-gray-500 ml-4">
                CodeSpace — Simple Code Editor
            </span>
        </div>

        <div class="flex items-center gap-1 pr-3">

            <button id="minimizeButton"
                title="Hide explorer"
                class="w-7 h-7 flex items-center justify-center text-gray-400 hover:bg-[#333] rounded">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M5 12h14"/>
                </svg>
            </button>

            <button id="maximizeButton"
                title="Toggle editor layout"
                class="w-7 h-7 flex items-center justify-center text-gray-400 hover:bg-[#333] rounded">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="5" y="5" width="14" height="14"/>
                </svg>
            </button>

        </div>

    </header>


    <!-- MAIN APPLICATION -->

    <div class="flex flex-1 min-h-0">

        <!-- ACTIVITY BAR -->

        <aside class="w-12 shrink-0 bg-[#181818] border-r border-[#333] flex flex-col justify-between">

            <div>

                <button class="activity-button active w-full h-12 flex items-center justify-center"
                    data-activity="explorer" title="Explorer">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M3 6.5h7l2 2h9v10H3z"/>
                        <path d="M3 6.5V5h7l2 2"/>
                    </svg>

                </button>

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="search" title="Search">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                        <circle cx="10.8" cy="10.8" r="6.8"/>
                        <path d="m16 16 5 5"/>
                    </svg>

                </button>

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="source" title="Source Control">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="6" cy="5" r="2"/>
                        <circle cx="6" cy="19" r="2"/>
                        <circle cx="18" cy="7" r="2"/>
                        <path d="M6 7v10M16 7h-3a4 4 0 0 0-4 4v2"/>
                        <path d="m13 10 3-3-3-3"/>
                    </svg>

                </button>

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="run" title="Run">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="m8 5 12 7-12 7z"/>
                    </svg>

                </button>

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="extensions" title="Extensions">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="3" y="3" width="7" height="7" rx="1"/>
                        <rect x="14" y="3" width="7" height="7" rx="1"/>
                        <rect x="3" y="14" width="7" height="7" rx="1"/>
                        <rect x="14" y="14" width="7" height="7" rx="1"/>
                    </svg>

                </button>

            </div>

            <div class="pb-2">

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="account" title="Account">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M4 21a8 8 0 0 1 16 0"/>
                    </svg>

                </button>

                <button class="activity-button w-full h-12 flex items-center justify-center"
                    data-activity="settings" title="Settings">

                    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-2 1.1l-.3 1.8h-3l-.3-1.8a8 8 0 0 1-2-1.1l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1 0-2.2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 2-1.1l.3-1.8h3l.3 1.8a8 8 0 0 1 2 1.1l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2.1Z" transform="translate(-1 -1) scale(1.08)"/>
                    </svg>

                </button>

            </div>

        </aside>


        <!-- EXPLORER SIDEBAR -->

        <aside id="sidebar"
            class="sidebar-transition w-60 shrink-0 bg-[#181818] border-r border-[#333] flex flex-col min-h-0">

            <div class="h-10 px-5 flex items-center justify-between shrink-0">

                <span id="sidebarTitle"
                    class="text-[11px] uppercase tracking-wide text-gray-300">
                    Explorer
                </span>

                <button id="collapseAll"
                    class="text-gray-500 hover:text-white"
                    title="Collapse all">

                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M4 7h16M7 11h10M10 15h4"/>
                    </svg>

                </button>

            </div>


            <!-- EXPLORER CONTENT -->

            <div id="explorerContent" class="flex-1 overflow-y-auto editor-scroll">

                <button id="projectToggle"
                    class="w-full h-8 flex items-center gap-1 px-3 text-xs font-bold text-gray-200 hover:bg-[#252526]">

                    <span id="projectArrow">⌄</span>

                    <svg width="15" height="15" viewBox="0 0 24 24" fill="#dcb67a">
                        <path d="M2 5h8l2 2h10v12H2z"/>
                    </svg>

                    <span>MY-PROJECT</span>

                </button>

                <div id="fileTree" class="pb-3">

                    <div class="pl-5">

                        <button class="file-row w-full h-7 flex items-center gap-2 px-2 text-xs"
                            data-file="index.html">

                            <span class="text-orange-400 font-bold">5</span>
                            <span>index.html</span>

                        </button>

                        <button class="file-row w-full h-7 flex items-center gap-2 px-2 text-xs"
                            data-file="app.js">

                            <span class="text-yellow-300 font-bold">JS</span>
                            <span>app.js</span>

                        </button>

                        <button class="file-row w-full h-7 flex items-center gap-2 px-2 text-xs"
                            data-file="style.css">

                            <span class="text-blue-400 font-bold">#</span>
                            <span>style.css</span>

                        </button>

                        <button class="file-row w-full h-7 flex items-center gap-2 px-2 text-xs"
                            data-file="README.md">

                            <span class="text-gray-400">≡</span>
                            <span>README.md</span>

                        </button>

                    </div>

                </div>

            </div>


            <!-- SIDEBAR FOOTER -->

            <div class="border-t border-[#333] shrink-0">

                <button class="w-full h-9 px-3 flex items-center justify-between text-xs text-gray-300 hover:bg-[#252526]">

                    <span>OUTLINE</span>
                    <span class="text-gray-500">›</span>

                </button>

                <button class="w-full h-9 px-3 flex items-center justify-between text-xs text-gray-300 hover:bg-[#252526]">

                    <span>TIMELINE</span>
                    <span class="text-gray-500">›</span>

                </button>

            </div>

        </aside>


        <!-- MAIN EDITOR -->

        <main class="flex-1 min-w-0 flex flex-col bg-[#1e1e1e]">

            <!-- EDITOR TABS -->

            <div id="tabBar"
                class="h-[35px] flex overflow-x-auto shrink-0 bg-[#181818] editor-scroll">

                <div class="flex items-stretch min-w-max" id="tabs"></div>

                <div class="flex-1"></div>

                <button id="closeAllTabs"
                    title="Close all tabs"
                    class="px-3 text-gray-500 hover:text-white hover:bg-[#333]">
                    ×
                </button>

            </div>


            <!-- BREADCRUMB -->

            <div class="h-[30px] shrink-0 flex items-center gap-2 px-4 text-xs text-gray-500">

                <span id="breadcrumbFolder">MY-PROJECT</span>
                <span>›</span>
                <span id="breadcrumbFile" class="text-gray-300">index.html</span>

            </div>


            <!-- CODE EDITOR -->

            <section id="editorArea" class="flex-1 min-h-0 relative overflow-hidden">

                <div id="editorScroll"
                    class="absolute inset-0 overflow-auto editor-scroll editor-font">

                    <div id="editorContent" class="min-w-max min-h-full">

                        <div id="codeLines" class="py-1"></div>

                    </div>

                </div>

            </section>


            <!-- BOTTOM PANEL -->

            <section id="bottomPanel"
                class="hidden h-44 shrink-0 border-t border-[#333] bg-[#1e1e1e] flex flex-col">

                <div class="h-9 flex items-center justify-between border-b border-[#333] px-4">

                    <div class="flex gap-5 text-[11px] uppercase text-gray-400">

                        <button class="panel-tab hover:text-white"
                            data-panel="problems">Problems</button>

                        <button class="panel-tab hover:text-white"
                            data-panel="output">Output</button>

                        <button class="panel-tab hover:text-white"
                            data-panel="debug">Debug Console</button>

                    </div>

                    <button id="closePanel"
                        class="text-gray-500 hover:text-white">
                        ×
                    </button>

                </div>

                <div id="panelContent"
                    class="p-4 text-xs text-gray-400 editor-font overflow-auto">
                    No problems detected.
                </div>

            </section>


            <!-- STATUS BAR -->

            <footer class="h-[23px] shrink-0 flex items-center justify-between bg-[#007acc] text-white text-[11px] select-none overflow-hidden">

                <div class="flex items-center min-w-0">

                    <button id="statusBranch" class="status-item hover:bg-white/10">
                        <span>⑂</span>
                        <span>main*</span>
                    </button>

                    <button id="statusErrors" class="status-item">
                        <span>ⓧ</span>
                        <span>0</span>

                        <span>⚠</span>
                        <span>0</span>
                    </button>

                    <span id="statusMessage"
                        class="hidden sm:inline px-2 truncate">
                        Ready
                    </span>

                </div>


                <div class="flex items-center shrink-0">

                    <button id="statusLine" class="status-item">
                        Ln 1, Col 1
                    </button>

                    <button id="statusSpaces" class="status-item hidden sm:inline-flex">
                        Spaces: 4
                    </button>

                    <button id="statusEncoding" class="status-item hidden sm:inline-flex">
                        UTF-8
                    </button>

                    <button id="statusLanguage" class="status-item">
                        HTML
                    </button>

                    <span class="status-item hidden sm:inline-flex">
                        <span>◉</span>
                        Prettier
                    </span>

                </div>

            </footer>

        </main>

    </div>

</div>


<!-- SEARCH OVERLAY -->

<div id="searchOverlay"
    class="hidden fixed inset-0 z-50 bg-black/40">

    <div class="w-[min(500px,90vw)] mx-auto mt-16 bg-[#252526] border border-[#454545] shadow-2xl rounded-md p-4">

        <div class="flex justify-between items-center mb-3">

            <h2 id="searchHeading" class="text-sm font-semibold">
                Search in files
            </h2>

            <button id="closeSearch"
                class="text-gray-400 hover:text-white">
                ×
            </button>

        </div>

        <input id="searchInput"
            type="text"
            placeholder="Search"
            class="w-full bg-[#3c3c3c] border border-[#555] px-3 py-2 rounded outline-none focus:border-blue-500 text-sm">

        <div id="searchResults"
            class="mt-3 max-h-64 overflow-auto text-xs text-gray-400"></div>

    </div>

</div>


<!-- JAVASCRIPT -->

<script src="app.js"></script>

</body>
</html>