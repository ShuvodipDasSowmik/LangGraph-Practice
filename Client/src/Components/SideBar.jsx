import React from 'react'

export default function SideBar({ topics = [], selectedId, onSelect, onNew }) {
    return (
        <aside className="w-72 bg-gray-900 text-gray-100 border-r border-gray-800 h-screen flex flex-col">
            <div className="p-4 flex items-center justify-between border-b border-gray-800">
                <h2 className="text-lg font-semibold">AI Analyst</h2>
                <button
                    onClick={onNew}
                    className="text-sm px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded-md"
                >
                    + New
                </button>
            </div>

            <div className="p-3 flex-1 overflow-auto">
                <div className="mb-3 text-xs text-gray-400 uppercase">Topics</div>
                <ul className="space-y-2">
                    {topics.map((t) => (
                        <li key={t.id}>
                            <button
                                onClick={() => onSelect(t.id)}
                                className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 text-sm ${selectedId === t.id
                                    ? 'bg-indigo-600 text-white'
                                    : 'bg-gray-800 text-gray-200 hover:bg-gray-700'
                                    }`}
                            >
                                <span className="truncate">{t.title}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="p-3 border-t border-gray-800 text-xs text-gray-400">
                <div className="mb-2">Projects</div>
                <div className="text-sm text-gray-300">AI Analytics</div>
            </div>
        </aside>
    )
}
