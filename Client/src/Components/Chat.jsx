import React, { useRef, useEffect, useState } from 'react'

export default function Chat({ topic, messages = [], onSend }) {
    const [input, setInput] = useState('')
    const scrollRef = useRef(null)
    const fileRef = useRef(null)
    const [pendingFile, setPendingFile] = useState(null)

    useEffect(() => {
        // scroll to bottom
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages, topic])

    const send = () => {
        const trimmed = input.trim()
        // allow sending file-only messages as well
        if (!trimmed && !pendingFile) return

        if (pendingFile) {
            // send both text (possibly empty) and file
            onSend({ text: trimmed, file: pendingFile })
            setPendingFile(null)
        } else {
            onSend(trimmed)
        }

        setInput('')
    }

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
        }
    }

    const handleFileChange = (e) => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        // store pending file locally; it will be sent together with the prompt when user clicks Send
        setPendingFile(file)
        // clear value so same file can be uploaded again if needed
        e.target.value = ''
    }

    const triggerFile = () => {
        fileRef.current?.click()
    }

    return (
        // `min-h-0` allows the flex child with overflow to shrink and become scrollable
        <div className="flex-1 flex flex-col bg-gray-900 text-gray-100 min-h-0">

            <div className="px-6 py-4 border-b border-gray-800">
                <div className="text-lg font-semibold">{topic?.title ?? 'New chat'}</div>
                <div className="text-xs text-gray-400">{topic?.subtitle ?? 'Ask anything'}</div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto p-6 space-y-4 min-h-0">
                {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-3xl inline-block px-4 py-2 rounded-lg ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-200'}`}>
                            <div className="whitespace-pre-wrap">{m.content}</div>
                            {m.fileName && (
                                <div className="mt-2 text-xs text-gray-300">📎 {m.fileName}</div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            <div className="p-4 border-t border-gray-800 bg-gradient-to-t from-gray-900">
                <div className="max-w-3xl mx-auto flex items-center gap-3">
                    <input ref={fileRef} type="file" className="hidden" onChange={handleFileChange} />
                    <button
                        onClick={triggerFile}
                        className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-md text-sm text-gray-200"
                        title="Upload a file"
                    >
                        📎
                    </button>

                    {pendingFile && (
                        <div className="px-3 py-2 rounded-md bg-gray-800 text-sm text-gray-200 border border-gray-700 mr-2">
                            📎 {pendingFile.name}
                        </div>
                    )}

                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        placeholder="Ask anything"
                        className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-md p-3 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <button
                        onClick={send}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-md text-white text-sm"
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    )
}
