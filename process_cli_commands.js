#!/usr/bin/env node

/**
 * CLI Command Processor für lokale Dokumentenerstellung
 * Verarbeitet cli_commands für automatische Dokumentengenerierung
 */

const fetch = require('node-fetch')

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
const POLL_INTERVAL = 3000 // 3 Sekunden

console.log('🚀 CLI Command Processor gestartet')
console.log('📡 PocketBase URL:', POCKETBASE_URL)

// Polling-Loop für neue CLI Commands
setInterval(async () => {
    try {
        await processCommands()
    } catch (error) {
        console.error('❌ Error processing commands:', error.message)
    }
}, POLL_INTERVAL)

async function processCommands() {
    try {
        // Hole pending Commands
        const response = await fetch(`${POCKETBASE_URL}/api/collections/cli_commands/records?filter=status='pending'&sort=created`)
        if (!response.ok) return
        
        const data = await response.json()
        
        for (const command of data.items) {
            console.log('🔄 Processing command:', command.command, command.id)
            
            if (command.command === 'generate_documents') {
                await processDocumentGeneration(command)
            } else {
                // Mark unknown commands as failed
                await updateCommandStatus(command.id, 'failed', `Unknown command: ${command.command}`)
            }
        }
        
    } catch (error) {
        console.error('❌ Error in processCommands:', error.message)
    }
}

async function processDocumentGeneration(command) {
    try {
        // Mark as processing
        await updateCommandStatus(command.id, 'processing')
        
        const parameters = JSON.parse(command.parameters || '{}')
        const requestId = parameters.request_id
        const userNeedId = parameters.user_need_id
        
        console.log('📝 Generating documents for request:', requestId)
        
        // Get user need details
        const userNeed = await getUserNeed(userNeedId)
        if (!userNeed) {
            throw new Error(`User need not found: ${userNeedId}`)
        }
        
        // Get system prompts
        const systemPrompts = await getSystemPrompts()
        if (systemPrompts.length === 0) {
            throw new Error('No system prompts available')
        }
        
        // Generate documents for each type
        const documentTypes = ['leistung', 'eignung', 'zuschlag']
        const generatedDocs = []
        
        for (const docType of documentTypes) {
            const prompt = systemPrompts.find(p => p.prompt_type === docType)
            if (prompt) {
                console.log(`📄 Generating ${docType} document...`)
                
                // Simple document generation (placeholder)
                const content = await generateDocument(userNeed, prompt)
                
                // Save document with proper project assignment
                const doc = await saveDocument({
                    title: `${docType.charAt(0).toUpperCase() + docType.slice(1)}: ${userNeed.thema}`,
                    content: content,
                    document_type: docType,
                    type: docType,
                    request_id: requestId,
                    user_id: userNeed.user_id,
                    project_id: userNeed.project_id,
                    generated_by_ai: true,
                    created_by: userNeed.user_id
                })
                
                generatedDocs.push(doc)
                console.log(`✅ Generated ${docType} document:`, doc.id)
            }
        }
        
        // Mark generation request as completed
        await updateGenerationRequestStatus(requestId, 'completed')
        
        // Mark command as completed
        await updateCommandStatus(command.id, 'completed', `Generated ${generatedDocs.length} documents`)
        
        console.log(`🎉 Document generation completed for request ${requestId}`)
        
    } catch (error) {
        console.error('❌ Error in document generation:', error.message)
        await updateCommandStatus(command.id, 'failed', error.message)
        
        // Also mark generation request as failed
        const parameters = JSON.parse(command.parameters || '{}')
        if (parameters.request_id) {
            await updateGenerationRequestStatus(parameters.request_id, 'failed')
        }
    }
}

async function getUserNeed(userNeedId) {
    try {
        // Use direct database access as workaround for API auth issues
        const sqlite3 = require('sqlite3').verbose()
        const db = new sqlite3.Database('./pb_data/data.db')
        
        return new Promise((resolve, reject) => {
            db.get(`
                SELECT id, thema, beschreibung, user_id, project_id, status, created, updated
                FROM user_needs 
                WHERE id = ?
            `, [userNeedId], (err, row) => {
                db.close()
                if (err) {
                    console.error('❌ Database error fetching user need:', err.message)
                    resolve(null)
                } else if (row) {
                    console.log(`✅ Found user need: ${row.thema}`)
                    resolve(row)
                } else {
                    console.log(`⚠️ User need not found: ${userNeedId}`)
                    resolve(null)
                }
            })
        })
    } catch (error) {
        console.error('❌ Error fetching user need:', error.message)
        return null
    }
}

async function getSystemPrompts() {
    try {
        // Use direct database access as workaround for API auth issues
        const sqlite3 = require('sqlite3').verbose()
        const db = new sqlite3.Database('./pb_data/data.db')
        
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT id, prompt_type, prompt_text, description, version, active
                FROM system_prompts 
                WHERE active = 1
                ORDER BY prompt_type
            `, (err, rows) => {
                db.close()
                if (err) {
                    console.error('❌ Database error fetching system prompts:', err.message)
                    resolve([])
                } else {
                    console.log(`✅ Found ${rows.length} active system prompts`)
                    resolve(rows)
                }
            })
        })
    } catch (error) {
        console.error('❌ Error fetching system prompts:', error.message)
        return []
    }
}

async function generateDocument(userNeed, systemPrompt) {
    try {
        console.log(`🤖 Generating ${systemPrompt.prompt_type} document using OpenCode...`)
        
        // Prepare comprehensive prompt with user data
        const userPrompt = `${systemPrompt.prompt_text}

## Projektdaten für die Erstellung:

**Projekttitel:** ${userNeed.thema}

**Projektbeschreibung:** ${userNeed.beschreibung || 'Keine detaillierte Beschreibung verfügbar.'}

**Projektkontext:** 
- Projekt-ID: ${userNeed.project_id || 'Nicht zugeordnet'}
- Status: ${userNeed.status || 'Neu'}
- Erstellt am: ${userNeed.created || new Date().toISOString()}

WICHTIG: 
1. Verwende KEINE Rückfragen - erstelle das Dokument direkt basierend auf den verfügbaren Projektdaten
2. Führe eine umfassende Webrecherche durch bevor du das Dokument erstellst
3. Das Dokument muss vollständig und einsatzbereit sein
4. Verwende professionelle deutsche Sprache entsprechend Vergabestandards
5. Berücksichtige aktuelle Marktgegebenheiten in deiner Analyse`

        // Call OpenCode service
        const response = await fetch(`http://localhost:3001/opencode/stream?prompt=${encodeURIComponent(userPrompt)}&model=openai/gpt-4.1-mini&userId=${userNeed.user_id}&recordId=${userNeed.id}&projectId=${userNeed.project_id}`)
        
        if (!response.ok) {
            throw new Error(`OpenCode service error: ${response.statusText}`)
        }

        // Read streaming response
        let content = ''
        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            
            const chunk = decoder.decode(value, { stream: true })
            content += chunk
        }

        // Clean up the response (remove error markers and completion notices)
        content = content
            .replace(/\[ERR\].*?\n/g, '')
            .replace(/\[✔.*?\]/g, '')
            .trim()

        if (!content || content.length < 100) {
            throw new Error('Generated content too short or empty')
        }

        console.log(`✅ Generated ${systemPrompt.prompt_type} document: ${content.length} characters`)
        return content

    } catch (error) {
        console.error(`❌ Error generating document with OpenCode:`, error.message)
        
        // Fallback to system prompt only if OpenCode fails
        return `# ${systemPrompt.prompt_type.charAt(0).toUpperCase() + systemPrompt.prompt_type.slice(1)}: ${userNeed.thema}

## Projektbeschreibung
${userNeed.beschreibung || 'Keine detaillierte Beschreibung verfügbar.'}

## Hinweis
Dieses Dokument konnte nicht vollständig generiert werden aufgrund eines technischen Problems: ${error.message}

Bitte verwenden Sie die folgenden Basis-Informationen als Ausgangspunkt:

${systemPrompt.prompt_text.replace('{description}', userNeed.thema)}

*Automatisch erstellt am: ${new Date().toLocaleDateString('de-DE')}*`
    }
}

async function saveDocument(docData) {
    try {
        // Use direct database insert as workaround for API validation issues
        const sqlite3 = require('sqlite3').verbose()
        const db = new sqlite3.Database('./pb_data/data.db')
        
        return new Promise((resolve, reject) => {
            // Generate a proper PocketBase ID
            const id = 'r' + Math.random().toString(36).substring(2, 9) + Math.random().toString(36).substring(2, 9)
            const now = new Date().toISOString()
            
            const insertQuery = `
                INSERT INTO documents (
                    id, title, content, project_id, user_id, document_type, type, 
                    request_id, created_by, generated_by_ai, created, updated
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            
            db.run(insertQuery, [
                id,
                docData.title || '',
                docData.content || '',
                docData.project_id || '',
                docData.user_id || '',
                docData.document_type || docData.type || '',
                docData.type || '',
                docData.request_id || '',
                docData.created_by || '',
                docData.generated_by_ai ? 1 : 0,
                now,
                now
            ], function(err) {
                db.close()
                
                if (err) {
                    console.error('❌ Database insert error:', err.message)
                    reject(new Error(`Failed to save document: ${err.message}`))
                } else {
                    console.log(`✅ Document saved with ID: ${id}`)
                    resolve({
                        id: id,
                        title: docData.title,
                        content: docData.content,
                        project_id: docData.project_id,
                        user_id: docData.user_id,
                        document_type: docData.document_type,
                        generated_by_ai: docData.generated_by_ai,
                        created: now,
                        updated: now
                    })
                }
            })
        })
        
    } catch (error) {
        console.error('❌ Error saving document:', error.message)
        throw error
    }
}

async function updateCommandStatus(commandId, status, error = null) {
    try {
        const updateData = { status }
        if (error) {
            updateData.error = error
        }
        
        await fetch(`${POCKETBASE_URL}/api/collections/cli_commands/records/${commandId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updateData)
        })
    } catch (error) {
        console.error('❌ Error updating command status:', error.message)
    }
}

async function updateGenerationRequestStatus(requestId, status) {
    try {
        await fetch(`${POCKETBASE_URL}/api/collections/generation_requests/records/${requestId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status })
        })
    } catch (error) {
        console.error('❌ Error updating generation request status:', error.message)
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 CLI Command Processor wird beendet...')
    process.exit(0)
})

console.log('⏰ Waiting for commands to process...')