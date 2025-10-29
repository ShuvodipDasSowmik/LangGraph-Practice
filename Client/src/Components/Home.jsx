import React, { useMemo, useState, useEffect } from 'react'
import SideBar from './SideBar'
import Chat from './Chat'
import API from '../API/API'

export default function Home() {
    const [topics, setTopics] = useState([])
    const [selectedId, setSelectedId] = useState(null)
    const [messagesByTopic, setMessagesByTopic] = useState({})

    useEffect(() => {
        // load topics from server
        (async () => {
            try {
                const resp = await API.get('/api/chatbot/topics')
                const data = resp.data
                setTopics(data)
                if (data.length > 0) {
                    setSelectedId(data[0].id)
                } else {
                    // create a default topic
                    const create = await API.post('/api/chatbot/topics', { title: 'General', subtitle: 'General questions' })
                    setTopics([create.data])
                    setSelectedId(create.data.id)
                }
            } catch (err) {
                console.error('Failed to load topics', err)
            }
        })()
    }, [])

    useEffect(() => {
        if (!selectedId) return
        // load messages for selected topic
        (async () => {
            try {
                const resp = await API.get(`/api/chatbot/topics/${selectedId}/messages`)
                setMessagesByTopic((m) => ({ ...m, [selectedId]: resp.data }))
            } catch (err) {
                console.error('Failed to load messages', err)
            }
        })()
    }, [selectedId])

    const selectedTopic = useMemo(() => topics.find((t) => t.id === selectedId), [topics, selectedId])

    const handleSelect = (id) => {
        setSelectedId(id)
    }

    const handleNew = async () => {
        try {
            const resp = await API.post('/api/chatbot/topics', { title: 'New chat', subtitle: 'Start a conversation' })
            const t = resp.data
            setTopics((s) => [t, ...s])
            setMessagesByTopic((m) => ({ ...m, [t.id]: [{ role: 'assistant', content: 'New chat created. Say hi!' }] }))
            setSelectedId(t.id)
        } catch (err) {
            console.error('Failed to create topic', err)
        }
    }

    const handleSend = async (payload) => {
        // ensure we have a topic to post to; create one if none selected
        let topicId = selectedId
        if (!topicId) {
            try {
                const resp = await API.post('/api/chatbot/topics', { title: 'New chat', subtitle: 'Start a conversation' })
                const t = resp.data
                setTopics((s) => [t, ...s])
                setMessagesByTopic((m) => ({ ...m, [t.id]: [] }))
                setSelectedId(t.id)
                topicId = t.id
            } catch (err) {
                console.error('Failed to create topic before send', err)
                return
            }
        }

        // helper to append message to the (possibly newly created) topic
        const append = (msg) => {
            setMessagesByTopic((prev) => {
                const old = prev[topicId] ?? []
                return { ...prev, [topicId]: [...old, msg] }
            })
        }

        if (typeof payload === 'string') {
            const text = payload
            append({ role: 'user', content: text })

            // Simple heuristic: if the user asks for aggregations or data summaries,
            // call the agent endpoint which will plan and run SQL on uploaded tables.
            const isDataQuestion = (t) => {
                if (!t) return false;
                const q = t.toLowerCase();
                const keywords = ['sum','total','average','avg','mean','count','by','group','revenue','sales','profit','median','max','min','show','list','top'];
                return keywords.some(k => q.includes(k));
            }

            if (isDataQuestion(text)) {
                try {
                    const resp = await API.post(`/api/chatbot/topics/${topicId}/agent-query`, { question: text });
                    const data = resp.data;
                    const answer = data?.answer || (data?.messages ? JSON.stringify(data.messages) : 'No answer');
                    append({ role: 'assistant', content: answer })
                } catch (err) {
                    console.error('Agent query failed', err)
                    append({ role: 'assistant', content: 'Error: failed to run data agent' })
                }
                return
            }

            // stream assistant reply
            try {
                const resp = await fetch(`${API.defaults.baseURL}/api/chatbot/topics/${topicId}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text })
                })

                if (!resp.body) {
                    const j = await resp.json()
                    append({ role: 'assistant', content: j.error || j.answer || 'No response' })
                    return
                }

                // create assistant placeholder
                append({ role: 'assistant', content: '' })

                const reader = resp.body.getReader()
                const decoder = new TextDecoder()
                let done = false
                while (!done) {
                    const { value, done: d } = await reader.read()
                    done = d
                    if (value) {
                        const chunk = decoder.decode(value)
                        // try parse JSON chunk from Ollama proxy
                        try {
                            const parsed = JSON.parse(chunk)
                            if (parsed.response) {
                                // append to last assistant message
                                setMessagesByTopic((prev) => {
                                    const old = prev[topicId] ?? []
                                    const last = old[old.length - 1]
                                    const updated = { ...last, content: (last.content || '') + parsed.response }
                                    return { ...prev, [topicId]: [...old.slice(0, -1), updated] }
                                })
                            }
                        } catch (e) {
                            // not JSON — append raw
                            setMessagesByTopic((prev) => {
                                const old = prev[topicId] ?? []
                                const last = old[old.length - 1]
                                const updated = { ...last, content: (last.content || '') + chunk }
                                return { ...prev, [topicId]: [...old.slice(0, -1), updated] }
                            })
                        }
                    }
                }
            } catch (err) {
                console.error('Send error', err)
                append({ role: 'assistant', content: 'Error: failed to get reply' })
            }
            return
        }

        // payload as { text, file }
        const { text = '', file } = payload || {}

    // show user message locally
    append({ role: 'user', content: text ? text : `Uploaded file: ${file.name}`, fileName: file.name })

        // If the uploaded file is a CSV, call the ingestion endpoint instead of posting to topic messages
                if (file && file.name && file.name.toLowerCase().endsWith('.csv')) {
            try {
                const form = new FormData()
                form.append('file', file)
                        // bind this upload to the current topic so schema is stored for the conversation
                        form.append('topicId', topicId)

                const resp = await API.post('/api/chatbot/upload-csv', form)
                const data = resp.data
                // show assistant confirmation
                append({ role: 'assistant', content: data.message || `CSV uploaded. ${data.inserted ? data.inserted + ' rows inserted.' : ''}` })
            } catch (err) {
                console.error('CSV upload failed', err)
                append({ role: 'assistant', content: 'Error: failed to upload CSV' })
            }

            return
        }

        // upload via form data to allow file (non-CSV files are sent as a normal topic message)
    const form = new FormData()
    form.append('text', text)
    form.append('file', file)

        try {
            const resp = await fetch(`${API.defaults.baseURL}/api/chatbot/topics/${topicId}/messages`, {
                method: 'POST',
                body: form
            })

            if (!resp.body) {
                const j = await resp.json()
                append({ role: 'assistant', content: j.error || 'No response' })
                return
            }

            // create assistant placeholder
            append({ role: 'assistant', content: '' })

            const reader = resp.body.getReader()
            const decoder = new TextDecoder()
            let done = false
            while (!done) {
                const { value, done: d } = await reader.read()
                done = d
                if (value) {
                    const chunk = decoder.decode(value)
                    try {
                        const parsed = JSON.parse(chunk)
                        if (parsed.response) {
                            setMessagesByTopic((prev) => {
                                const old = prev[topicId] ?? []
                                const last = old[old.length - 1]
                                const updated = { ...last, content: (last.content || '') + parsed.response }
                                return { ...prev, [topicId]: [...old.slice(0, -1), updated] }
                            })
                        }
                    } catch (e) {
                        setMessagesByTopic((prev) => {
                            const old = prev[topicId] ?? []
                            const last = old[old.length - 1]
                            const updated = { ...last, content: (last.content || '') + chunk }
                            return { ...prev, [topicId]: [...old.slice(0, -1), updated] }
                        })
                    }
                }
            }
        } catch (err) {
            console.error('Upload/send failed', err)
            append({ role: 'assistant', content: 'Error: failed to get reply' })
        }
    }

    return (
        <div className="flex h-screen bg-gray-900 text-gray-100">
            <SideBar topics={topics} selectedId={selectedId} onSelect={handleSelect} onNew={handleNew} />

            <main className="flex-1 flex flex-col">
                <Chat topic={selectedTopic} messages={messagesByTopic[selectedId] ?? []} onSend={handleSend} />
            </main>
        </div>
    )
}
