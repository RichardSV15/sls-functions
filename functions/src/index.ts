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

// Email recipients
const recipientEmails = ['RichardSV15@gmail.com', 'DanielSV17@gmail.com'];

// Recipient phone numbers
const recipientPhoneNumbers = ['+15595675330', '+15595677354', '+15592136764'];
// Map of team member phone numbers to names
const teamMembers: { [phoneNumber: string]: string } = {
    '+15595675330': 'Richard',
    '+15595677354': 'Daniel',
    '+15592136764': 'Julia',
    '+15592419140': 'Inocencio'
};

const RICHARD_EMAIL = 'RichardSV15@gmail.com';
const RICHARD_PHONE = '+15595675330';


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

/** Format cents to dollar string */
function formatPrice(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

/** Format a Firestore timestamp or ISO string to readable Pacific Time date */
function formatDate(dateValue: any): string {
    if (!dateValue) return 'N/A';
    const date = dateValue.toDate ? dateValue.toDate() : new Date(dateValue);
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

function flattenChecklistItems(data: any): Array<{ key: string; label: string; flagged: boolean; photoUrls: string[] }> {
    const items: Array<{ key: string; label: string; flagged: boolean; photoUrls: string[] }> = [];
    const sections = Array.isArray(data?.sections) ? data.sections : [];

    sections.forEach((section: any) => {
        const sectionId = String(section?.sectionId || section?.id || 'section');
        const sectionItems = Array.isArray(section?.items) ? section.items : [];
        sectionItems.forEach((item: any) => {
            items.push({
                key: `${sectionId}:${String(item?.id || item?.label || 'item')}`,
                label: String(item?.label || item?.id || 'Checklist item'),
                flagged: Boolean(item?.flagged),
                photoUrls: Array.isArray(item?.photoUrls) ? item.photoUrls : [],
            });
        });
    });

    return items;
}

function getNewHazards(beforeData: any, afterData: any): any[] {
    const beforeIds = new Set(
        (Array.isArray(beforeData?.hazards) ? beforeData.hazards : []).map((hazard: any) =>
            String(hazard?.id || '')
        )
    );

    return (Array.isArray(afterData?.hazards) ? afterData.hazards : []).filter(
        (hazard: any) => !beforeIds.has(String(hazard?.id || ''))
    );
}

function getNewFlaggedItems(beforeData: any, afterData: any): Array<{ label: string; photoUrls: string[] }> {
    const beforeMap = new Map(
        flattenChecklistItems(beforeData).map((item) => [item.key, item])
    );

    return flattenChecklistItems(afterData)
        .filter((item) => item.flagged && !beforeMap.get(item.key)?.flagged)
        .map((item) => ({
            label: item.label,
            photoUrls: item.photoUrls,
        }));
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
            content.push({
                margin: [0, 0, 0, 8],
                text: `Weather: High ${section.weatherData.highTemp || 0}°F · Shade Ready: ${section.weatherData.shadeReady ? 'Yes' : 'No'} · Buddy System: ${section.weatherData.buddySystemOn ? 'Yes' : 'No'}`,
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

function getPreviousMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
        label: start.toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'America/Los_Angeles',
        }),
    };
}

export const onChecklistHazardOrDefectReported = functions
    .runWith({ secrets: allSecrets })
    .firestore
    .document('checklists/{checklistId}')
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();

        if (!beforeData || !afterData) return null;

        const newHazards = getNewHazards(beforeData, afterData);
        const newFlaggedItems = getNewFlaggedItems(beforeData, afterData);

        if (newHazards.length === 0 && newFlaggedItems.length === 0) {
            return null;
        }

        const checklistId = context.params.checklistId;
        const adminLink = `https://www.suarezlawnservices.com/admin/checklists`;
        const truckName = afterData.truckDisplayName || afterData.truckId || checklistId;
        const employeeName = afterData.completedByName || afterData.signature?.employeeName || 'Field employee';

        const hazardHtml = newHazards.map((hazard: any) => `
            <li><strong>Hazard:</strong> ${hazard.hazardFound || 'N/A'}<br />
            Location: ${hazard.location || 'N/A'} · Fixed: ${hazard.fixed ? 'Yes' : 'No'}<br />
            Photos: ${(hazard.photoUrls || []).join(', ') || 'None'}</li>
        `).join('');

        const flaggedHtml = newFlaggedItems.map((item) => `
            <li><strong>Flagged Item:</strong> ${item.label}<br />
            Photos: ${item.photoUrls.join(', ') || 'None'}</li>
        `).join('');

        const html = `
            <h2>Checklist Hazard / Defect Alert</h2>
            <p>A new hazard or flagged defect was reported.</p>
            <p><strong>Truck:</strong> ${truckName}<br />
            <strong>Employee:</strong> ${employeeName}<br />
            <strong>Date:</strong> ${afterData.date || 'N/A'}</p>
            ${newHazards.length > 0 ? `<h3>New Hazards</h3><ul>${hazardHtml}</ul>` : ''}
            ${newFlaggedItems.length > 0 ? `<h3>New Flagged Items</h3><ul>${flaggedHtml}</ul>` : ''}
            <p><a href="${adminLink}">Open Admin Checklist View</a></p>
        `;

        const smsBody = [
            'SLS: Checklist alert',
            '',
            `Truck: ${truckName}`,
            `Employee: ${employeeName}`,
            `Date: ${afterData.date || 'N/A'}`,
            ...newHazards.map((hazard: any) => `Hazard: ${hazard.hazardFound || 'N/A'}`),
            ...newFlaggedItems.map((item) => `Flagged: ${item.label}`),
            adminLink,
        ].join('\n');

        await sendEmail(
            `Checklist Alert - ${truckName}`,
            html,
            { to: [RICHARD_EMAIL] }
        );
        await sendSMS(
            smsBody,
            { to: [RICHARD_PHONE] }
        );

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

export const monthlyChecklistReport = functions
    .runWith({ secrets: allSecrets })
    .pubsub.schedule('0 8 1 * *')
    .timeZone('America/Los_Angeles')
    .onRun(async () => {
        const range = getPreviousMonthRange();
        const snapshot = await admin.firestore()
            .collection('checklists')
            .where('date', '>=', range.start)
            .where('date', '<', range.end)
            .get();

        const checklists = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }));

        if (checklists.length === 0) {
            await sendEmail(
                `Monthly Checklist Report - ${range.label}`,
                `<p>No checklists were recorded for ${range.label}.</p>`,
                { to: ['SuarezLawnServices.LLC@gmail.com'] }
            );
            return null;
        }

        const summaryDefinition = {
            pageMargins: [32, 32, 32, 32],
            content: [
                { text: 'Suarez Lawn Services', style: 'header' },
                { text: `Monthly Checklist Report - ${range.label}`, style: 'subheader' },
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
        const attachmentName = `monthly-checklists-${range.start}.pdf`;

        await sendEmail(
            `Monthly Checklist Report - ${range.label}`,
            `<p>Attached is the checklist report for ${range.label}.</p>`,
            {
                to: ['SuarezLawnServices.LLC@gmail.com'],
                attachments: [
                    {
                        filename: attachmentName,
                        content: pdfBuffer,
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

        const messageBody = `
            <h2>New Service Request Created</h2>
            <p>A new service request has been created with the following details:</p>
            <table style="width: 100%; border-collapse: collapse;">
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Request ID:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${requestId}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Name:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customerName}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone Number:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.phoneNumber ? newValue.phoneNumber : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Service Type:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${serviceType}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Time:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${formattedTimestamp}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.address ? newValue.address : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Recurring Info:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.recurringServices ? newValue.recurringServices : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>One Time Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.oneTimeServices ? newValue.oneTimeServices : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Landscape Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.landscapingServices ? newValue.landscapingServices : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Optional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.optionalDetails ? newValue.optionalDetails : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Additional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.additionalInfo ? newValue.additionalInfo : 'N/A'}</td>
            </tr>
            
            ${customerEmail !== 'N/A' ? `
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer Email:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customerEmail}</td>
            </tr>
            ` : ''}
            </table>
        `;

        // Construct the SMS message body (compact, SMS-friendly)
        const smsLines: string[] = [];
        smsLines.push('SLS: New service request!!!');
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
        if (newValue.oneTimeServices.length > 0) smsLines.push(`One-time: ${newValue.oneTimeServices}`);
        if (newValue.landscapingServices.length > 0) smsLines.push(`Landscape: ${newValue.landscapingServices}`);
        smsLines.push('');
        if (newValue.optionalDetails) smsLines.push(`Optional: ${newValue.optionalDetails}`);
        if (newValue.additionalInfo) smsLines.push(`Additional: ${newValue.additionalInfo}`);
        if (newValue.request_photo_urls) smsLines.push(`Additional images: ${newValue.request_photo_urls.length}`);
        if (newValue.special_offer_photo_url != null) smsLines.push('Promo image: Yes!');
        smsLines.push(`https://www.suarezlawnservices.com/service-request/${requestId}`);
        if (customerEmail !== 'N/A') smsLines.push(`Email: ${customerEmail}`);
        smsLines.push(`ID: ${requestId}`);
        const textMessageBody = smsLines.join('\n');

        const mode = newValue.mode || 'live';

        if (mode === 'live') {
            console.log('LIVE MODE: Sending email');
            try {
                await sendEmail('New Service Request', messageBody);
                console.log('Email sent successfully');
            } catch (error) {
                console.error('Error sending email:', error);
            }

            try {
                await sendSMS(textMessageBody);
                console.log('SMS sent successfully');
            } catch (error) {
                console.error('Error sending SMS:', error);
            }

        } else {
            console.log('DEBUG MODE: Email not sent');
            console.log('Email content:', messageBody);
        }

        return null;
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

        // HTML email
        const emailHtml = `
            <h2>New Subscription</h2>
            <p>A new customer has subscribed to lawn services:</p>
            <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${customerName}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${customerPhone}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Email:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${customerEmail}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${address}</td>
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
                <td style="padding: 8px; border: 1px solid #ddd;">${nextServiceDate}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Zone:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${zoneName}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Department:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${capitalize(department)}</td>
            </tr>
            ${referredByCode ? `
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Referred By:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${referredByCode}</td>
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
                <td style="padding: 8px; border: 1px solid #ddd;">${customerName}</td>
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
                <td style="padding: 8px; border: 1px solid #ddd;">${invoiceId}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Status:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${subscriptionStatus}</td>
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
            <td style="padding: 8px; border: 1px solid #ddd;">${customerName}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${customerPhone}</td>
        </tr>
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Address:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${address}</td>
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
            <td style="padding: 8px; border: 1px solid #ddd;">${customerName}</td>
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
            <td style="padding: 8px; border: 1px solid #ddd;">${canceledAt}</td>
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
    }
): Promise<void> {
    const client = twilio(twilioSid.value(), twilioToken.value());
    const targets = options?.to || recipientPhoneNumbers;
    const sendSMSPromises = targets.map(async (phoneNumber) => {
        await client.messages.create({
            body: body,
            from: twilioPhone.value(),
            to: phoneNumber
        });
    });

    await Promise.all(sendSMSPromises);
}
