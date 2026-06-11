// functions/src/index.ts

import * as functions from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import twilio from 'twilio';
import express from 'express';
import * as bodyParser from 'body-parser';
const PdfPrinter = require('pdfmake');


// Initialize Firebase Admin SDK
admin.initializeApp();

// Define secrets (values stored in Cloud Secret Manager)
const gmailPass = defineSecret('GMAIL_PASS');
const twilioSid = defineSecret('TWILIO_SID');
const twilioToken = defineSecret('TWILIO_TOKEN');
const twilioPhone = defineSecret('TWILIO_PHONE');

const allSecrets = [gmailPass, twilioSid, twilioToken, twilioPhone];

// Email config
const gmailUser = "RichardSV15@gmail.com";

// Email recipients. The LLC inbox is included so notifications land in the
// actively-monitored business account too (personal inboxes can filter
// self-/peer-sent Gmail unpredictably).
const recipientEmails = ['RichardSV15@gmail.com', 'DanielSV17@gmail.com', 'SuarezLawnServices.LLC@gmail.com'];

// Recipient phone numbers
const recipientPhoneNumbers = ['+15595675330', '+15595677354', '+15592136764'];
// Map of team member phone numbers to names
const teamMembers: { [phoneNumber: string]: string } = {
    '+15595675330': 'Richard',
    '+15595677354': 'Daniel',
    '+15592136764': 'Julia',
    '+15592419140': 'Inocencio'
};



// ── Utility Helpers ──

/** Map plan type slug to human-readable label */
function formatPlanType(planType: string): string {
    const labels: Record<string, string> = {
        'front_biweekly': 'Front Yard - Every 2 Weeks',
        'front_monthly': 'Front Yard - Monthly',
        'front_back_biweekly': 'Front + Back Yard - Every 2 Weeks',
        'front_back_monthly': 'Front + Back Yard - Monthly',
    };
    return labels[planType] || planType;
}

/** Format cents to dollar string. Coerces missing/non-numeric values to $0.00
 * so a legacy doc without `priceInCents` doesn't render "$NaN" in emails/SMS. */
function formatPrice(cents: number | null | undefined): string {
    const n = typeof cents === 'number' ? cents : Number(cents);
    if (!Number.isFinite(n)) return '$0.00';
    return `$${(n / 100).toFixed(2)}`;
}

/** Format a Firestore timestamp or ISO string to readable Pacific Time date */
function formatDate(dateValue: any): string {
    if (!dateValue) return 'N/A';
    const date = dateValue?.toDate ? dateValue.toDate() : new Date(dateValue);
    // Guard against unparseable strings/numbers — otherwise we'd render the
    // literal "Invalid Date" into emails/SMS/PDF.
    if (!(date instanceof Date) || isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

/** Capitalize first letter of a string */
function capitalize(str: string): string {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Escape HTML special characters in user-supplied strings before embedding
 * in HTML email bodies. Customer form fields and free-text inputs flow into
 * `<td>${value}</td>` templates below; without escaping, a value containing
 * `<` / `>` / quotes breaks layout and lets arbitrary markup through. */
function escapeHtml(value: any): string {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}



function getPdfFonts() {
    return {
        Helvetica: {
            normal: 'Helvetica',
            bold: 'Helvetica-Bold',
            italics: 'Helvetica-Oblique',
            bolditalics: 'Helvetica-BoldOblique',
        },
    };
}

function createPdfBuffer(docDefinition: any): Promise<Buffer> {
    const printer = new PdfPrinter(getPdfFonts());
    const pdfDoc = printer.createPdfKitDocument(docDefinition);
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        pdfDoc.end();
    });
}

function buildChecklistPdfDefinition(checklistId: string, checklist: any, title?: string) {
    const sections = Array.isArray(checklist?.sections) ? checklist.sections : [];
    const hazards = Array.isArray(checklist?.hazards) ? checklist.hazards : [];
    const signature = checklist?.signature || null;
    const generatedTitle = title || `DES Checklist Report`;
    const content: any[] = [
        { text: 'Suarez Lawn Services', style: 'header' },
        { text: generatedTitle, style: 'subheader' },
        {
            columns: [
                [
                    { text: `Checklist ID: ${checklistId}` },
                    { text: `Truck: ${checklist?.truckDisplayName || checklist?.truckId || 'N/A'}` },
                    { text: `Department: ${capitalize(checklist?.department || 'n/a')}` },
                ],
                [
                    { text: `Date: ${checklist?.date || 'N/A'}` },
                    { text: `Status: ${String(checklist?.status || 'N/A').replace('_', ' ')}` },
                    { text: `Completed By: ${checklist?.completedByName || 'N/A'}` },
                ],
            ],
            columnGap: 20,
            margin: [0, 0, 0, 12],
        },
    ];

    sections.forEach((section: any) => {
        content.push({ text: section?.title || 'Section', style: 'sectionHeader' });
        const items = Array.isArray(section?.items) ? section.items : [];
        if (items.length === 0) {
            content.push({ text: 'No items recorded.', margin: [0, 0, 0, 8] });
        } else {
            content.push({
                margin: [0, 0, 0, 8],
                layout: 'lightHorizontalLines',
                table: {
                    widths: [20, '*', 55, 55],
                    body: [
                        [
                            { text: '', bold: true },
                            { text: 'Item', bold: true },
                            { text: 'Source', bold: true },
                            { text: 'Status', bold: true },
                        ],
                        ...items.map((item: any) => [
                            { text: item?.checked ? '☑' : '☐', alignment: 'center' },
                            { text: item?.label || 'Item' },
                            { text: item?.source || 'base' },
                            { text: item?.flagged ? 'Flagged' : item?.checked ? 'Checked' : 'Unchecked' },
                        ]),
                    ],
                },
            });
        }

        if (section?.weatherData) {
            // Distinguish missing high-temp from a real 0°F reading — falsy
            // coalescing with `|| 0` rendered "High 0°F" for any null/undefined.
            const high = section.weatherData.highTemp;
            const highText = typeof high === 'number' && Number.isFinite(high) ? `${high}°F` : 'N/A';
            content.push({
                margin: [0, 0, 0, 8],
                text: `Weather: High ${highText} · Shade Ready: ${section.weatherData.shadeReady ? 'Yes' : 'No'} · Buddy System: ${section.weatherData.buddySystemOn ? 'Yes' : 'No'}`,
            });
        }
    });

    content.push({ text: 'Hazards', style: 'sectionHeader' });
    content.push({
        margin: [0, 0, 0, 8],
        layout: 'lightHorizontalLines',
        table: {
            widths: [55, 90, '*', '*', 45, 60],
            body: [
                [
                    { text: 'Time', bold: true },
                    { text: 'Location', bold: true },
                    { text: 'Hazard', bold: true },
                    { text: 'Corrective Action', bold: true },
                    { text: 'Fixed', bold: true },
                    { text: 'Date', bold: true },
                ],
                ...(hazards.length > 0
                    ? hazards.map((hazard: any) => [
                        { text: hazard?.time || 'N/A' },
                        { text: hazard?.location || 'N/A' },
                        { text: hazard?.hazardFound || 'N/A' },
                        { text: hazard?.correctiveAction || 'N/A' },
                        { text: hazard?.fixed ? 'Yes' : 'No' },
                        { text: hazard?.fixedDate || '—' },
                    ])
                    : [[
                        { text: '—' },
                        { text: '—' },
                        { text: 'No hazards recorded', colSpan: 4 },
                        {},
                        {},
                        {},
                    ]]),
            ],
        },
    });

    content.push({ text: 'Digital Signature', style: 'sectionHeader' });
    content.push({
        text: signature
            ? `Employee: ${signature.employeeName} (${signature.employeeUid}) · Phone: ${signature.employeePhone} · Timestamp: ${formatDate(signature.timestamp)}`
            : 'No submission signature recorded.',
        margin: [0, 0, 0, 8],
    });

    content.push({
        text: 'Legal basis: Cal/OSHA inspection records maintained electronically with authenticated submission, attribution, integrity, and retention.',
        style: 'footerNote',
    });

    return {
        pageMargins: [32, 32, 32, 32],
        content,
        styles: {
            header: { fontSize: 18, bold: true },
            subheader: { fontSize: 13, margin: [0, 4, 0, 12] },
            sectionHeader: { fontSize: 12, bold: true, margin: [0, 8, 0, 6] },
            footerNote: { fontSize: 9, italics: true, margin: [0, 12, 0, 0] },
        },
        defaultStyle: {
            font: 'Helvetica',
            fontSize: 10,
        },
    };
}

async function uploadPdfBuffer(storagePath: string, buffer: Buffer): Promise<string> {
    const bucket = admin.storage().bucket();
    const token = admin.firestore().collection('_').doc().id;
    const file = bucket.file(storagePath);

    await file.save(buffer, {
        resumable: false,
        metadata: {
            contentType: 'application/pdf',
            metadata: {
                firebaseStorageDownloadTokens: token,
            },
        },
    });

    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

async function generateChecklistPdfFile(checklistId: string, title?: string): Promise<{ pdfUrl: string; buffer: Buffer }> {
    const doc = await admin.firestore().collection('checklists').doc(checklistId).get();
    if (!doc.exists) {
        throw new Error('Checklist not found');
    }

    const checklist = doc.data()!;
    const pdfBuffer = await createPdfBuffer(
        buildChecklistPdfDefinition(checklistId, checklist, title)
    );
    const pdfUrl = await uploadPdfBuffer(`checklists/${checklistId}/report.pdf`, pdfBuffer);

    return { pdfUrl, buffer: pdfBuffer };
}

function getMonthRange(month?: string) {
    if (month) {
        if (!/^\d{4}-\d{2}$/.test(month)) {
            throw new Error('Invalid month format');
        }
        const [yearString, monthString] = month.split('-');
        const year = Number(yearString);
        const monthIndex = Number(monthString) - 1;
        if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
            throw new Error('Invalid month format');
        }

        const start = new Date(Date.UTC(year, monthIndex, 1));
        const end = new Date(Date.UTC(year, monthIndex + 1, 1));
        return {
            month,
            start: start.toISOString().slice(0, 10),
            end: end.toISOString().slice(0, 10),
            label: start.toLocaleString('en-US', {
                month: 'long',
                year: 'numeric',
                timeZone: 'America/Los_Angeles',
            }),
        };
    }

    // Use UTC consistently — the explicit-month branch above uses Date.UTC,
    // and toISOString() always emits UTC. Mixing local-time constructors with
    // toISOString() can drift across month boundaries when this runs from a
    // non-UTC server.
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return {
        month: start.toISOString().slice(0, 7),
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
        label: start.toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'America/Los_Angeles',
        }),
    };
}

async function loadMonthlyChecklistEntries(filters: { month?: string; department?: string | null; truckId?: string | null }) {
    const range = getMonthRange(filters.month);
    const snapshot = await admin.firestore()
        .collection('checklists')
        .where('date', '>=', range.start)
        .where('date', '<', range.end)
        .get();

    const checklists = snapshot.docs
        .map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }))
        .filter((entry: any) => {
            if (filters.department && entry.department !== filters.department) {
                return false;
            }
            if (filters.truckId && entry.truckId !== filters.truckId) {
                return false;
            }
            return true;
        })
        .sort((a: any, b: any) => {
            if (a.date === b.date) {
                return String(a.truckDisplayName || a.truckId || a.id).localeCompare(
                    String(b.truckDisplayName || b.truckId || b.id)
                );
            }
            return String(a.date || '').localeCompare(String(b.date || ''));
        });

    return { range, checklists };
}

async function generateMonthlyChecklistReportFile(filters: { month?: string; department?: string | null; truckId?: string | null }) {
    const { range, checklists } = await loadMonthlyChecklistEntries(filters);

    if (checklists.length === 0) {
        throw new Error('No checklists found for the selected month');
    }

    const scopeParts = [
        filters.department ? `Department: ${capitalize(filters.department)}` : null,
        filters.truckId ? `Truck: ${filters.truckId}` : null,
    ].filter(Boolean);
    const scopeLabel = scopeParts.length > 0 ? ` (${scopeParts.join(' · ')})` : '';

    const summaryDefinition = {
        pageMargins: [32, 32, 32, 32],
        content: [
            { text: 'Suarez Lawn Services', style: 'header' },
            { text: `Monthly Checklist Report - ${range.label}${scopeLabel}`, style: 'subheader' },
            {
                table: {
                    widths: ['*', 80, 90, 80],
                    body: [
                        [
                            { text: 'Truck', bold: true },
                            { text: 'Date', bold: true },
                            { text: 'Status', bold: true },
                            { text: 'Hazards', bold: true },
                        ],
                        ...checklists.map((entry: any) => [
                            { text: entry.truckDisplayName || entry.truckId || entry.id },
                            { text: entry.date || 'N/A' },
                            { text: String(entry.status || 'N/A').replace('_', ' ') },
                            { text: String((entry.hazards || []).length) },
                        ]),
                    ],
                },
            },
            ...checklists.flatMap((entry: any, index: number) => ([
                { text: '', pageBreak: index === 0 ? undefined : 'before' },
                ...buildChecklistPdfDefinition(entry.id, entry, `Checklist ${index + 1}`).content,
            ])),
        ],
        styles: {
            header: { fontSize: 18, bold: true },
            subheader: { fontSize: 13, margin: [0, 4, 0, 12] },
        },
        defaultStyle: {
            font: 'Helvetica',
            fontSize: 10,
        },
    };

    const pdfBuffer = await createPdfBuffer(summaryDefinition);
    const pathParts = ['reports', 'checklists', 'monthly', range.month];
    if (filters.department) pathParts.push(filters.department);
    if (filters.truckId) pathParts.push(filters.truckId);
    const storagePath = `${pathParts.join('/')}.pdf`;
    const pdfUrl = await uploadPdfBuffer(storagePath, pdfBuffer);

    return {
        pdfUrl,
        buffer: pdfBuffer,
        checklistCount: checklists.length,
        label: range.label,
    };
}

/**
 * Checklist submission alert — fires only on status transitions
 * (morning_complete or completed) and only if there are actionable
 * items: notes on required items, hazards, or unfixed defects.
 * Sends email only (no SMS) to the business inbox.
 */
export const onChecklistSubmissionAlert = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('checklists/{checklistId}')
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();

        if (!beforeData || !afterData) return null;

        const beforeStatus = String(beforeData.status || '');
        const afterStatus = String(afterData.status || '');

        // Only fire on actual submission transitions
        const isMorningSubmission = beforeStatus !== 'morning_complete' && afterStatus === 'morning_complete';
        const isDayCompletion = beforeStatus !== 'completed' && afterStatus === 'completed';

        if (!isMorningSubmission && !isDayCompletion) return null;

        // Collect actionable items: required items with notes, all hazards, unfixed flagged items
        const sections = Array.isArray(afterData.sections) ? afterData.sections : [];
        const hazards = Array.isArray(afterData.hazards) ? afterData.hazards : [];

        const itemsWithNotes: Array<{ label: string; note: string; photoUrls: string[] }> = [];
        sections.forEach((section: any) => {
            const items = Array.isArray(section?.items) ? section.items : [];
            items.forEach((item: any) => {
                if (item?.required && item?.note && String(item.note).trim()) {
                    itemsWithNotes.push({
                        label: String(item.label || 'Item'),
                        note: String(item.note),
                        photoUrls: Array.isArray(item.photoUrls) ? item.photoUrls : [],
                    });
                }
            });
        });

        const unfixedHazards = hazards.filter((h: any) => !h.fixed);

        // Nothing actionable — no email needed
        if (itemsWithNotes.length === 0 && hazards.length === 0) {
            return null;
        }

        const checklistId = context.params.checklistId;
        const adminLink = `https://www.suarezlawnservices.com/admin/checklists`;
        const truckName = afterData.truckDisplayName || afterData.truckId || checklistId;
        const submittedBy = afterData.morningCompletedByName || afterData.completedByName
            || afterData.signature?.employeeName || 'Field employee';
        const phase = isDayCompletion ? 'End of Day' : 'Morning Inspection';

        const notesHtml = itemsWithNotes.map((item) => `
            <li><strong>${escapeHtml(item.label)}</strong><br />
            Note: ${escapeHtml(item.note)}
            ${item.photoUrls.length > 0 ? `<br />Photos: ${item.photoUrls.map(escapeHtml).join(', ')}` : ''}</li>
        `).join('');

        const hazardHtml = hazards.map((hazard: any) => `
            <li><strong>${escapeHtml(hazard.hazardFound || 'N/A')}</strong><br />
            Location: ${escapeHtml(hazard.location || 'N/A')} ·
            Fixed: ${hazard.fixed ? 'Yes' : '<strong style="color:red">No</strong>'}
            ${hazard.correctiveAction ? `<br />Action: ${escapeHtml(hazard.correctiveAction)}` : ''}
            ${(hazard.photoUrls || []).length > 0 ? `<br />Photos: ${(hazard.photoUrls || []).map(escapeHtml).join(', ')}` : ''}</li>
        `).join('');

        const subjectParts = [];
        if (unfixedHazards.length > 0) subjectParts.push(`${unfixedHazards.length} unfixed hazard(s)`);
        if (itemsWithNotes.length > 0) subjectParts.push(`${itemsWithNotes.length} noted issue(s)`);
        if (subjectParts.length === 0 && hazards.length > 0) subjectParts.push(`${hazards.length} hazard(s) reported`);

        const html = `
            <h2>Checklist Action Required</h2>
            <p><strong>Truck:</strong> ${escapeHtml(truckName)}<br />
            <strong>Submitted by:</strong> ${escapeHtml(submittedBy)}<br />
            <strong>Phase:</strong> ${escapeHtml(phase)}<br />
            <strong>Date:</strong> ${escapeHtml(afterData.date || 'N/A')}</p>
            ${itemsWithNotes.length > 0 ? `<h3>Required Items with Notes</h3><ul>${notesHtml}</ul>` : ''}
            ${hazards.length > 0 ? `<h3>Hazards Reported</h3><ul>${hazardHtml}</ul>` : ''}
            <p><a href="${adminLink}">Open Admin Checklist View</a></p>
        `;

        // Don't let a transient SMTP failure bubble — the Firestore trigger
        // would retry the entire function and resend the alert next time the
        // checklist is updated. Log instead so we can investigate.
        try {
            await sendEmail(
                `Checklist: ${subjectParts.join(', ')} — ${truckName}`,
                html,
                { to: ['SuarezLawnServices.LLC@gmail.com'] }
            );
        } catch (error) {
            console.error('Error sending checklist submission alert email:', error);
        }

        return null;
    });

export const generateChecklistPdf = functions
    .https.onRequest(async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }

        try {
            const checklistId = String(req.body?.checklistId || '').trim();
            if (!checklistId) {
                res.status(400).json({ error: 'checklistId is required' });
                return;
            }

            const result = await generateChecklistPdfFile(checklistId);
            res.status(200).json(result);
        } catch (error: any) {
            console.error('Error generating checklist PDF:', error);
            res.status(500).json({ error: error?.message || 'Failed to generate checklist PDF' });
        }
    });

export const generateMonthlyChecklistReportPdf = functions
    .https.onRequest(async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'Method not allowed' });
            return;
        }

        try {
            const month = req.body?.month ? String(req.body.month).trim() : undefined;
            const department = req.body?.department ? String(req.body.department).trim() : null;
            const truckId = req.body?.truckId ? String(req.body.truckId).trim() : null;

            const result = await generateMonthlyChecklistReportFile({
                month,
                department,
                truckId,
            });

            res.status(200).json(result);
        } catch (error: any) {
            console.error('Error generating monthly checklist PDF:', error);
            res.status(500).json({ error: error?.message || 'Failed to generate monthly checklist PDF' });
        }
    });

export const monthlyChecklistReport = functions
    .runWith({ secrets: allSecrets })
    .pubsub.schedule('0 8 1 * *')
    .timeZone('America/Los_Angeles')
    .onRun(async () => {
        let result;
        try {
            result = await generateMonthlyChecklistReportFile({});
        } catch (error: any) {
            if (error?.message === 'No checklists found for the selected month') {
                const range = getMonthRange();
                await sendEmail(
                    `Monthly Checklist Report - ${range.label}`,
                    `<p>No checklists were recorded for ${range.label}.</p>`,
                    { to: ['SuarezLawnServices.LLC@gmail.com'] }
                );
                return null;
            }

            throw error;
        }

        const range = getMonthRange();
        const attachmentName = `monthly-checklists-${range.start}.pdf`;

        await sendEmail(
            `Monthly Checklist Report - ${range.label}`,
            `<p>Attached is the checklist report for ${range.label}.</p>`,
            {
                to: ['SuarezLawnServices.LLC@gmail.com'],
                attachments: [
                    {
                        filename: attachmentName,
                        content: result.buffer,
                        contentType: 'application/pdf',
                    },
                ],
            }
        );

        return null;
    });


/**
 * Cloud Function to send an email upon service request creation.
 */
export const sendCompletionNotification = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('serviceRequests/{requestId}')
    .onCreate(async (snapshot, context) => {
        const newValue = snapshot.data();
        const requestId = context.params.requestId;

        if (!newValue) {
            console.error('No data found in the new service request.');
            return null;
        }

        // Extract fields with default values
        const serviceType = newValue.serviceType || 'N/A';
        const customerName = newValue.fullName || 'N/A';
        const customerEmail = newValue.customerEmail || 'N/A'; // Optional: if you have customer's email


        // Construct the HTML email body
        const formattedTimestamp = newValue.timestamp
            ? newValue.timestamp.toDate().toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles', // Convert to Pacific Time
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                hour12: true
            })
            : 'N/A';

        // Render arrays as comma-joined strings; everything that comes from
        // customer input is HTML-escaped before interpolation.
        const renderField = (value: any): string => {
            if (value == null || value === '') return 'N/A';
            if (Array.isArray(value)) return escapeHtml(value.filter(Boolean).join(', ')) || 'N/A';
            return escapeHtml(value);
        };

        const messageBody = `
            <h2>New Service Request Created</h2>
            <p>A new service request has been created with the following details:</p>
            <table style="width: 100%; border-collapse: collapse;">
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Request ID:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(requestId)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Name:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerName)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone Number:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.phoneNumber)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Service Type:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(serviceType)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Time:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formattedTimestamp)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.address)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Recurring Info:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.recurringServices)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>One Time Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.oneTimeServices)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Landscape Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.landscapingServices)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Optional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.optionalDetails)}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Additional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${renderField(newValue.additionalInfo)}</td>
            </tr>

            ${customerEmail !== 'N/A' ? `
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer Email:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerEmail)}</td>
            </tr>
            ` : ''}
            </table>
        `;

        // Construct the SMS message body (compact, SMS-friendly).
        //
        // Long customer free-text MUST be truncated: a ~1,300-char pasted
        // project description pushed a request SMS past the carrier content
        // limit (Twilio error 30019) on 2026-06-10 and ALL recipients silently
        // missed it. Full details are always in the email + dashboard link.
        const truncateForSms = (text: string, max: number): string => {
            const s = String(text).trim();
            return s.length > max ? `${s.slice(0, max).trimEnd()}… [see email/link]` : s;
        };

        const smsLines: string[] = [];
        smsLines.push('SLS: New service request!!!');
        // Link sits on line 2 — recurringServices items could push everything
        // else past the 1000-char truncation cap below, and we MUST preserve
        // the link so the team can open the request.
        smsLines.push(`https://www.suarezlawnservices.com/service-request/${requestId}`);
        smsLines.push('');
        if (formattedTimestamp !== 'N/A') smsLines.push(`Time: ${formattedTimestamp}`);
        smsLines.push(`Name: ${customerName}`);
        if (newValue.phoneNumber) smsLines.push(`Phone: ${newValue.phoneNumber}`);
        if (newValue.address) smsLines.push(`Address: ${newValue.address}`);
        smsLines.push('');
        smsLines.push(`Wants: ${serviceType} service`);
        if (newValue.recurringFrequency) smsLines.push(`Frequency: ${newValue.recurringFrequency}`);

        if (Array.isArray(newValue.recurringServices) && newValue.recurringServices.length > 0) {
            newValue.recurringServices.forEach((item: string) => {
                if (item) smsLines.push(`- ${item}`);
            });
        } else if (typeof newValue.recurringServices === 'string' && newValue.recurringServices.trim().length > 0) {
            smsLines.push(`Recurring: ${newValue.recurringServices}`);
        }
        // Guard with String(... || '') — legacy docs may omit these fields, and a
        // throw here means NO notification at all.
        if (String(newValue.oneTimeServices || '').length > 0) smsLines.push(`One-time: ${newValue.oneTimeServices}`);
        if (String(newValue.landscapingServices || '').length > 0) smsLines.push(`Landscape: ${newValue.landscapingServices}`);
        smsLines.push('');
        if (customerEmail !== 'N/A') smsLines.push(`Email: ${customerEmail}`);
        if (newValue.optionalDetails) smsLines.push(`Optional: ${truncateForSms(newValue.optionalDetails, 200)}`);
        if (newValue.additionalInfo) smsLines.push(`Additional: ${truncateForSms(newValue.additionalInfo, 200)}`);
        if (Array.isArray(newValue.request_photo_urls) && newValue.request_photo_urls.length > 0) {
            smsLines.push(`Additional images: ${newValue.request_photo_urls.length}`);
        }
        if (newValue.special_offer_photo_url != null) smsLines.push('Promo image: Yes!');
        smsLines.push(`ID: ${requestId}`);
        let textMessageBody = smsLines.join('\n');
        // Final safety cap — well under Twilio's 1,600-char limit and carrier
        // segment caps. The link sits early in the body, so it always survives.
        if (textMessageBody.length > 1000) {
            textMessageBody = `${textMessageBody.slice(0, 1000).trimEnd()}…`;
        }

        const mode = newValue.mode || 'live';

        if (mode === 'live') {
            // Per-channel result, written back to the request doc so the admin
            // dashboard can show delivery status instead of failures being
            // invisible (Twilio "accepted" ≠ delivered).
            const notifications: Record<string, unknown> = {};

            console.log('LIVE MODE: Sending email');
            try {
                await sendEmail('New Service Request', messageBody);
                console.log('Email sent successfully');
                notifications.email = { status: 'sent', to: recipientEmails };
            } catch (error) {
                console.error('Error sending email:', error);
                notifications.email = { status: 'failed', error: String(error) };
            }

            try {
                const statusCallback =
                    `https://us-central1-suarezlawnservices-sls.cloudfunctions.net/twilioSmsStatus?requestId=${requestId}`;
                const sids = await sendSMS(textMessageBody, { statusCallback });
                console.log('SMS accepted by Twilio:', sids.join(', '));
                // "accepted" — final per-recipient delivery status arrives via
                // the twilioSmsStatus callback and is recorded under
                // notifications.sms.delivery.{sid}.
                notifications.sms = { status: 'accepted', sids, to: recipientPhoneNumbers };
            } catch (error) {
                console.error('Error sending SMS:', error);
                notifications.sms = { status: 'failed', error: String(error) };
            }

            try {
                await snapshot.ref.set(
                    { notifications: { ...notifications, at: admin.firestore.FieldValue.serverTimestamp() } },
                    { merge: true }
                );
            } catch (error) {
                console.error('Error writing notification status:', error);
            }

        } else {
            console.log('DEBUG MODE: Email not sent');
            console.log('Email content:', messageBody);
        }

        return null;
    });


/**
 * Twilio SMS status callback — records the FINAL delivery status of each
 * team-notification SMS on the originating serviceRequests doc, and emails the
 * team when a message fails to deliver (e.g. carrier content filtering, which
 * Twilio reports AFTER accepting the send).
 *
 * Auth: instead of fragile signature/URL reconstruction, we require that the
 * posted MessageSid matches one of the SIDs we stored on the request doc when
 * sending — only Twilio (and this project) know those SIDs.
 */
export const twilioSmsStatus = functions
    .runWith({ secrets: allSecrets })
    .https.onRequest(async (req, res) => {
        try {
            const requestId = String(req.query.requestId || '');
            const messageSid = String(req.body?.MessageSid || req.body?.SmsSid || '');
            const messageStatus = String(req.body?.MessageStatus || '');
            const to = String(req.body?.To || '');
            const errorCode = req.body?.ErrorCode ? String(req.body.ErrorCode) : null;

            if (!requestId || !messageSid || !messageStatus) {
                res.status(400).send('Missing requestId, MessageSid, or MessageStatus');
                return;
            }

            const docRef = admin.firestore().collection('serviceRequests').doc(requestId);

            // Read-modify-write inside a transaction so concurrent callbacks
            // for the same SID don't both observe `prevStatus === undefined`
            // and both fire the failure-alert email below.
            const txnResult = await admin.firestore().runTransaction(async (txn) => {
                const snap = await txn.get(docRef);
                if (!snap.exists) {
                    return { kind: 'missing' as const };
                }
                const data = snap.data() || {};
                const knownSids: string[] = data.notifications?.sms?.sids || [];
                if (!knownSids.includes(messageSid)) {
                    return { kind: 'unknown-sid' as const };
                }
                const prevStatus: string | undefined =
                    data.notifications?.sms?.delivery?.[messageSid]?.status;

                txn.set(docRef, {
                    notifications: {
                        sms: {
                            delivery: {
                                [messageSid]: {
                                    to,
                                    status: messageStatus,
                                    errorCode,
                                    at: admin.firestore.FieldValue.serverTimestamp(),
                                },
                            },
                        },
                    },
                }, { merge: true });

                return { kind: 'ok' as const, prevStatus, data };
            });

            if (txnResult.kind === 'missing') {
                res.status(404).send('Unknown request');
                return;
            }
            if (txnResult.kind === 'unknown-sid') {
                console.error(`SID ${messageSid} not registered on request ${requestId}`);
                res.status(403).send('Unknown message SID');
                return;
            }

            const { prevStatus, data } = txnResult;

            // Terminal failure → alert the team by email (a different failure
            // domain than SMS). Guard against duplicate callbacks for the same
            // terminal status.
            const isFailure = messageStatus === 'undelivered' || messageStatus === 'failed';
            if (isFailure && prevStatus !== messageStatus) {
                const name = teamMembers[to] || to;
                console.error(`SMS to ${to} ${messageStatus} (error ${errorCode}) for request ${requestId}`);
                try {
                    await sendEmail(
                        `⚠️ SMS notification FAILED — service request ${requestId}`,
                        `<p>The new-service-request SMS to <strong>${escapeHtml(name)}</strong> (${escapeHtml(to)}) was ` +
                        `<strong>${escapeHtml(messageStatus)}</strong>${errorCode ? ` (Twilio error ${escapeHtml(errorCode)})` : ''}.</p>` +
                        `<p>Customer: ${escapeHtml(data.fullName || 'N/A')} — ${escapeHtml(data.phoneNumber || 'N/A')}</p>` +
                        `<p><a href="https://www.suarezlawnservices.com/service-request/${encodeURIComponent(requestId)}">View the request</a> ` +
                        `so it doesn't get missed.</p>`
                    );
                } catch (error) {
                    console.error('Error sending SMS-failure alert email:', error);
                }
            }

            res.status(200).send('OK');
        } catch (error) {
            console.error('twilioSmsStatus error:', error);
            res.status(500).send('Internal error');
        }
    });


/**
 * Cloud Function to notify the team when a new Stripe subscription is created.
 * Triggers on: subscriptions/{subId} — onCreate
 */
export const sendNewSubscriptionNotification = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('subscriptions/{subId}')
    .onCreate(async (snapshot, context) => {
        const data = snapshot.data();
        const subId = context.params.subId;

        if (!data) {
            console.error('No data found in new subscription doc.');
            return null;
        }

        const customerName = data.customerName || 'N/A';
        const customerPhone = data.customerPhone || 'N/A';
        const customerEmail = data.customerEmail || 'N/A';
        const address = data.address || 'N/A';
        const planType = data.planType || 'N/A';
        const priceInCents = data.priceInCents || 0;
        const serviceDay = data.serviceDay || 'N/A';
        const nextServiceDate = data.nextServiceDate || 'N/A';
        const zoneName = data.zoneName || 'N/A';
        const department = data.department || 'N/A';
        const referredByCode = data.referredByCode || null;
        const adminLink = `https://www.suarezlawnservices.com/admin/subscriptions/${subId}`;

        // HTML email — every customer-supplied field is escaped before
        // embedding. formatPlanType/formatPrice/capitalize/adminLink come from
        // trusted internal sources so they pass through untouched.
        const emailHtml = `
            <h2>New Subscription</h2>
            <p>A new customer has subscribed to lawn services:</p>
            <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerName)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerPhone)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Email:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerEmail)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(address)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Plan:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${formatPlanType(planType)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Price:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${formatPrice(priceInCents)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Service Day:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${capitalize(serviceDay)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>First Service Date:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(nextServiceDate)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Zone:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(zoneName)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Department:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${capitalize(department)}</td>
            </tr>
            ${referredByCode ? `
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Referred By:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(referredByCode)}</td>
            </tr>
            ` : ''}
            </table>
            <p><a href="${adminLink}">View in Admin Panel</a></p>
        `;

        // SMS
        const smsLines: string[] = [];
        smsLines.push('SLS: New subscription!');
        smsLines.push('');
        smsLines.push(`Customer: ${customerName}`);
        smsLines.push(`Phone: ${customerPhone}`);
        smsLines.push(`Address: ${address}`);
        smsLines.push(`Plan: ${formatPlanType(planType)}`);
        smsLines.push(`Price: ${formatPrice(priceInCents)}`);
        smsLines.push(`Service Day: ${capitalize(serviceDay)}`);
        smsLines.push(`First Service: ${nextServiceDate}`);
        smsLines.push(`Zone: ${zoneName}  Dept: ${capitalize(department)}`);
        if (referredByCode) smsLines.push(`Referred by: ${referredByCode}`);
        smsLines.push(adminLink);
        const smsBody = smsLines.join('\n');

        try {
            await sendEmail(`New Subscription - ${customerName}`, emailHtml);
            console.log('New subscription email sent');
        } catch (error) {
            console.error('Error sending new subscription email:', error);
        }

        try {
            await sendSMS(smsBody);
            console.log('New subscription SMS sent');
        } catch (error) {
            console.error('Error sending new subscription SMS:', error);
        }

        return null;
    });


/**
 * Cloud Function to notify the team when a subscription payment is received.
 * Triggers on: subscriptions/{subId}/payments/{paymentId} — onCreate
 */
export const sendPaymentReceivedNotification = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('subscriptions/{subId}/payments/{paymentId}')
    .onCreate(async (snapshot, context) => {
        const paymentData = snapshot.data();
        const subId = context.params.subId;

        if (!paymentData) {
            console.error('No data found in payment doc.');
            return null;
        }

        // Fetch parent subscription for customer details
        const subDoc = await admin.firestore()
            .collection('subscriptions')
            .doc(subId)
            .get();

        if (!subDoc.exists) {
            console.error(`Parent subscription ${subId} not found for payment notification`);
            return null;
        }

        const subData = subDoc.data()!;
        const customerName = subData.customerName || 'N/A';
        const amountPaid = paymentData.amountPaid || 0;
        const invoiceId = paymentData.stripeInvoiceId || 'N/A';
        const planType = subData.planType || 'N/A';
        const subscriptionStatus = subData.status || 'N/A';
        const adminLink = `https://www.suarezlawnservices.com/admin/subscriptions/${subId}`;

        // HTML email
        const emailHtml = `
            <h2>Payment Received</h2>
            <p>A subscription payment has been received:</p>
            <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerName)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Amount:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${formatPrice(amountPaid)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Plan:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${formatPlanType(planType)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Invoice ID:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(invoiceId)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Status:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(subscriptionStatus)}</td>
            </tr>
            </table>
            <p><a href="${adminLink}">View in Admin Panel</a></p>
        `;

        // SMS
        const smsBody = [
            'SLS: Payment received!',
            '',
            `Customer: ${customerName}`,
            `Amount: ${formatPrice(amountPaid)}`,
            `Plan: ${formatPlanType(planType)}`,
            `Invoice: ${invoiceId}`,
            `Status: ${subscriptionStatus}`,
            adminLink,
        ].join('\n');

        try {
            await sendEmail(`Payment Received - ${customerName}`, emailHtml);
            console.log('Payment received email sent');
        } catch (error) {
            console.error('Error sending payment received email:', error);
        }

        try {
            await sendSMS(smsBody);
            console.log('Payment received SMS sent');
        } catch (error) {
            console.error('Error sending payment received SMS:', error);
        }

        return null;
    });


/**
 * Cloud Function to notify the team on subscription status changes.
 * Handles: payment_failed and canceled status transitions.
 * Triggers on: subscriptions/{subId} — onUpdate
 */
export const onSubscriptionStatusChange = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('subscriptions/{subId}')
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();
        const subId = context.params.subId;

        // Mirrors the guard in onChecklistSubmissionAlert — defensive against
        // the rare case where snapshot data is missing.
        if (!beforeData || !afterData) return null;

        const beforeStatus = beforeData.status;
        const afterStatus = afterData.status;

        // Only proceed if status actually changed
        if (beforeStatus === afterStatus) {
            return null;
        }

        if (afterStatus === 'payment_failed') {
            await notifyPaymentFailed(subId, afterData);
        } else if (afterStatus === 'canceled') {
            await notifyCancellation(subId, afterData);
        }

        return null;
    });


/** Send payment failed notification to the team */
async function notifyPaymentFailed(
    subId: string,
    data: FirebaseFirestore.DocumentData
): Promise<void> {
    const customerName = data.customerName || 'N/A';
    const customerPhone = data.customerPhone || 'N/A';
    const address = data.address || 'N/A';
    const planType = data.planType || 'N/A';
    const priceInCents = data.priceInCents || 0;
    const adminLink = `https://www.suarezlawnservices.com/admin/subscriptions/${subId}`;

    const emailHtml = `
        <h2 style="color: #d32f2f;">Payment Failed</h2>
        <p style="color: #d32f2f;">A subscription payment has failed. Please follow up with the customer:</p>
        <table style="width: 100%; border-collapse: collapse;">
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerName)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerPhone)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(address)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Plan:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${formatPlanType(planType)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Price:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${formatPrice(priceInCents)}</td>
        </tr>
        </table>
        <p><a href="${adminLink}">View in Admin Panel</a></p>
    `;

    const smsBody = [
        'SLS: Payment FAILED!',
        '',
        `Customer: ${customerName}`,
        `Phone: ${customerPhone}`,
        `Address: ${address}`,
        `Plan: ${formatPlanType(planType)}`,
        `Price: ${formatPrice(priceInCents)}`,
        adminLink,
    ].join('\n');

    try {
        await sendEmail(`Payment Failed - ${customerName}`, emailHtml);
        console.log('Payment failed email sent');
    } catch (error) {
        console.error('Error sending payment failed email:', error);
    }

    try {
        await sendSMS(smsBody);
        console.log('Payment failed SMS sent');
    } catch (error) {
        console.error('Error sending payment failed SMS:', error);
    }
}


/** Send cancellation notification to the team */
async function notifyCancellation(
    subId: string,
    data: FirebaseFirestore.DocumentData
): Promise<void> {
    const customerName = data.customerName || 'N/A';
    const planType = data.planType || 'N/A';
    const priceInCents = data.priceInCents || 0;
    const canceledAt = data.canceledAt ? formatDate(data.canceledAt) : 'N/A';
    const adminLink = `https://www.suarezlawnservices.com/admin/subscriptions/${subId}`;

    const emailHtml = `
        <h2>Subscription Canceled</h2>
        <p>A customer has canceled their subscription:</p>
        <table style="width: 100%; border-collapse: collapse;">
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerName)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Plan:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${formatPlanType(planType)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Price:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${formatPrice(priceInCents)}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Canceled At:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(canceledAt)}</td>
        </tr>
        </table>
        <p><a href="${adminLink}">View in Admin Panel</a></p>
    `;

    const smsBody = [
        'SLS: Subscription CANCELED',
        '',
        `Customer: ${customerName}`,
        `Plan: ${formatPlanType(planType)}`,
        `Price: ${formatPrice(priceInCents)}`,
        `Canceled: ${canceledAt}`,
        adminLink,
    ].join('\n');

    try {
        await sendEmail(`Subscription Canceled - ${customerName}`, emailHtml);
        console.log('Cancellation email sent');
    } catch (error) {
        console.error('Error sending cancellation email:', error);
    }

    try {
        await sendSMS(smsBody);
        console.log('Cancellation SMS sent');
    } catch (error) {
        console.error('Error sending cancellation SMS:', error);
    }
}


/**
 * Cloud Function to handle incoming SMS messages from team members.
 */
export const handleIncomingSms = functions
    .runWith({ secrets: allSecrets })
    .https.onRequest((req, res) => {
    const app = express();

    // Parse incoming form data
    app.use(bodyParser.urlencoded({ extended: false }));

    // Twilio webhook validation middleware
    app.use((req, res, next) => {
        // Reconstruct the full URL
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['host'];
        const url = req.originalUrl || req.url;
        const fullUrl = `${protocol}://${host}${url}handleIncomingSms`;
        // Log the full URL
        console.log('Full URL used for validation:', fullUrl);

        // Validate the Twilio request
        const twilioSignature = req.headers['x-twilio-signature'] as string;
        const isValid = twilio.validateRequest(
            twilioToken.value(),
            twilioSignature,
            fullUrl,
            req.body
        );

        if (!isValid) {
            console.error('Invalid Twilio signature');
            res.status(403).send('Invalid Twilio signature');
        } else {
            next();
        }
    });

    // Handle the incoming SMS
    app.post('*', async (req, res) => {
        const fromNumber = req.body.From as string;
        const messageBody = req.body.Body as string;

        console.log('Received message from:', fromNumber);
        console.log('Message body:', messageBody);

        if (!fromNumber || !messageBody) {
            res.status(400).send('Missing From or Body in request');
            return;
        }

        if (!teamMembers[fromNumber]) {
            // Not from a team member, ignore or handle as a customer message
            res.status(200).send('Sender not in team members');
            return;
        }

        const senderName = teamMembers[fromNumber];

        // Prepare the message to send to other team members
        const messageToSend = `${senderName}: ${messageBody}`;

        // Send SMS to other team members
        const otherTeamMembers = Object.keys(teamMembers).filter(number => number !== fromNumber);

        try {
            const client = twilio(twilioSid.value(), twilioToken.value());
            const sendSMSPromises = otherTeamMembers.map(async (phoneNumber) => {
                console.log(`Sending message to ${phoneNumber}`);
                await client.messages.create({
                    body: messageToSend,
                    from: twilioPhone.value(),
                    to: phoneNumber
                });
            });

            await Promise.all(sendSMSPromises);

            console.log('Message forwarded to team members');
            res.status(200).send('Message forwarded');
        } catch (error) {
            console.error('Error sending SMS:', error);
            res.status(500).send('Error sending SMS');
        }
    });

    // Pass the request to the Express app
    app(req, res);
});


// /**
//  * Validates that incoming requests genuinely came from Twilio.
//  *
//  * @param {string} authToken - Your Twilio Auth Token.
//  * @param {string} twilioSignature - The signature from Twilio in the request headers.
//  * @param {string} url - The full URL of the request.
//  * @param {Record<string, any>} params - The body parameters of the request.
//  * @return {boolean} - True if the request is valid, false otherwise.
//  */
// function validateTwilioRequest(
//     authToken: string,
//     twilioSignature: string,
//     url: string,
//     params: Record<string, any>
// ): boolean {
//     const sortedParams = Object.keys(params)
//         .sort()
//         .reduce((acc: Record<string, any>, key: string) => {
//             acc[key] = params[key];
//             return acc;
//         }, {});

//     const data = url + Object.keys(sortedParams).reduce((acc, key) => acc + key + sortedParams[key], '');

//     const computedSignature = crypto
//         .createHmac('sha1', authToken)
//         .update(Buffer.from(data, 'utf-8'))
//         .digest('base64');

//     return twilioSignature === computedSignature;
// }



/**
 * Sends an email using Nodemailer.
 *
 * @param {string} subject - The email subject.
 * @param {string} html - The email body in HTML format.
 * @return {Promise<void>} - A promise that resolves when the email is sent.
 */
async function sendEmail(
    subject: string,
    html: string,
    options?: {
        to?: string[];
        attachments?: nodemailer.SendMailOptions['attachments'];
    }
): Promise<void> {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: gmailUser,
            pass: gmailPass.value()
        }
    });

    const mailOptions = {
        from: 'RichardSV15@gmail.com',  // Sender address from config
        to: (options?.to || recipientEmails).join(', '),   // List of recipients
        subject: subject,                // Subject line
        html: html,                      // HTML body
        attachments: options?.attachments,
    };

    await transporter.sendMail(mailOptions);
}

/**
 * Sends SMS messages using Twilio.
 *
 * @param {string} body - The SMS message body.
 * @return {Promise<void>} - A promise that resolves when all SMS messages are sent.
 */
async function sendSMS(
    body: string,
    options?: {
        to?: string[];
        /** Twilio status-callback URL — Twilio POSTs delivery updates
         *  (sent/delivered/undelivered/failed) per message. */
        statusCallback?: string;
    }
): Promise<string[]> {
    const client = twilio(twilioSid.value(), twilioToken.value());
    const targets = options?.to || recipientPhoneNumbers;
    const messages = await Promise.all(targets.map((phoneNumber) =>
        client.messages.create({
            body: body,
            from: twilioPhone.value(),
            to: phoneNumber,
            ...(options?.statusCallback ? { statusCallback: options.statusCallback } : {}),
        })
    ));
    return messages.map((m) => m.sid);
}
