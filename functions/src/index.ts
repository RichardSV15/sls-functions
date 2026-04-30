// functions/src/index.ts

import * as functions from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import * as nodemailer from 'nodemailer';
import twilio from 'twilio';
import express from 'express';
import * as bodyParser from 'body-parser';


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
    if (dateValue === null || dateValue === undefined || dateValue === '') return 'N/A';
    let date: Date;
    try {
        date = typeof dateValue?.toDate === 'function' ? dateValue.toDate() : new Date(dateValue);
    } catch {
        return 'N/A';
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

/** Format a Firestore timestamp or ISO string with both date and time (Pacific). */
function formatDateTime(dateValue: any): string {
    if (dateValue === null || dateValue === undefined || dateValue === '') return 'N/A';
    let date: Date;
    try {
        date = typeof dateValue?.toDate === 'function' ? dateValue.toDate() : new Date(dateValue);
    } catch {
        return 'N/A';
    }
    if (!(date instanceof Date) || isNaN(date.getTime())) return 'N/A';
    return date.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true,
    });
}

/** Capitalize first letter of a string */
function capitalize(str: string): string {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Escape user-controlled values before interpolating into HTML. */
function escapeHtml(value: any): string {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** True when the value is a non-empty array, a non-blank string, or otherwise truthy. */
function hasContent(value: any): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return Boolean(value);
}


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
        const formattedTimestamp = formatDateTime(newValue.timestamp);

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
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.phoneNumber ? escapeHtml(newValue.phoneNumber) : 'N/A'}</td>
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
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.address ? escapeHtml(newValue.address) : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Recurring Info:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${hasContent(newValue.recurringServices) ? escapeHtml(Array.isArray(newValue.recurringServices) ? newValue.recurringServices.join(', ') : newValue.recurringServices) : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>One Time Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${hasContent(newValue.oneTimeServices) ? escapeHtml(Array.isArray(newValue.oneTimeServices) ? newValue.oneTimeServices.join(', ') : newValue.oneTimeServices) : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Landscape Services Wanted:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${hasContent(newValue.landscapingServices) ? escapeHtml(Array.isArray(newValue.landscapingServices) ? newValue.landscapingServices.join(', ') : newValue.landscapingServices) : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Optional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.optionalDetails ? escapeHtml(newValue.optionalDetails) : 'N/A'}</td>
            </tr>
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Additional Details:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${newValue.additionalInfo ? escapeHtml(newValue.additionalInfo) : 'N/A'}</td>
            </tr>

            ${customerEmail !== 'N/A' ? `
            <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Customer Email:</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(customerEmail)}</td>
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
        if (hasContent(newValue.oneTimeServices)) {
            const oneTime = Array.isArray(newValue.oneTimeServices)
                ? newValue.oneTimeServices.join(', ')
                : newValue.oneTimeServices;
            smsLines.push(`One-time: ${oneTime}`);
        }
        if (hasContent(newValue.landscapingServices)) {
            const landscape = Array.isArray(newValue.landscapingServices)
                ? newValue.landscapingServices.join(', ')
                : newValue.landscapingServices;
            smsLines.push(`Landscape: ${landscape}`);
        }
        smsLines.push('');
        if (newValue.optionalDetails) smsLines.push(`Optional: ${newValue.optionalDetails}`);
        if (newValue.additionalInfo) smsLines.push(`Additional: ${newValue.additionalInfo}`);
        if (Array.isArray(newValue.request_photo_urls) && newValue.request_photo_urls.length > 0) {
            smsLines.push(`Additional images: ${newValue.request_photo_urls.length}`);
        }
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
        const priceInCents = typeof data.priceInCents === 'number' ? data.priceInCents : 0;
        const serviceDay = data.serviceDay || 'N/A';
        const nextServiceDate = formatDate(data.nextServiceDate);
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
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formatPlanType(planType))}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Price:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${formatPrice(priceInCents)}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Service Day:</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(capitalize(serviceDay))}</td>
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
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(capitalize(department))}</td>
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
        let subDoc: FirebaseFirestore.DocumentSnapshot;
        try {
            subDoc = await admin.firestore()
                .collection('subscriptions')
                .doc(subId)
                .get();
        } catch (error) {
            console.error(`Failed to fetch subscription ${subId} for payment notification:`, error);
            return null;
        }

        if (!subDoc.exists) {
            console.error(`Parent subscription ${subId} not found for payment notification`);
            return null;
        }

        const subData = subDoc.data() || {};
        const customerName = subData.customerName || 'N/A';
        const amountPaid = typeof paymentData.amountPaid === 'number' ? paymentData.amountPaid : 0;
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
                <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formatPlanType(planType))}</td>
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

        if (!afterData) {
            console.error(`onSubscriptionStatusChange: missing after-data for subscription ${subId}`);
            return null;
        }

        const beforeStatus = beforeData ? beforeData.status : undefined;
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
    const priceInCents = typeof data.priceInCents === 'number' ? data.priceInCents : 0;
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
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formatPlanType(planType))}</td>
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
    const priceInCents = typeof data.priceInCents === 'number' ? data.priceInCents : 0;
    const canceledAt = formatDate(data.canceledAt);
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
            <td style="padding: 8px; border: 1px solid #ddd;">${escapeHtml(formatPlanType(planType))}</td>
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
        // Reconstruct the full URL Twilio used to sign the request.
        // Firebase HTTPS functions strip the function name from the path, so
        // we re-insert "/handleIncomingSms" before any query string instead of
        // appending to the end (which would corrupt the query string).
        const forwardedProto = req.headers['x-forwarded-proto'];
        const protocol = Array.isArray(forwardedProto)
            ? forwardedProto[0]
            : (forwardedProto || 'https');
        const hostHeader = req.headers['host'];
        const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
        const rawUrl = req.originalUrl || req.url || '/';
        const queryIndex = rawUrl.indexOf('?');
        const pathPart = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
        const queryPart = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
        const FN_NAME = 'handleIncomingSms';
        const normalizedPath = pathPart.endsWith(`/${FN_NAME}`)
            ? pathPart
            : (pathPart === '/' || pathPart === ''
                ? `/${FN_NAME}`
                : `${pathPart.replace(/\/$/, '')}/${FN_NAME}`);
        const fullUrl = `${protocol}://${host}${normalizedPath}${queryPart}`;
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
        const fromRaw = req.body && req.body.From;
        const bodyRaw = req.body && req.body.Body;
        const fromNumber = typeof fromRaw === 'string' ? fromRaw : '';
        const messageBody = typeof bodyRaw === 'string' ? bodyRaw : '';

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
            const results = await Promise.allSettled(
                otherTeamMembers.map(async (phoneNumber) => {
                    console.log(`Sending message to ${phoneNumber}`);
                    await client.messages.create({
                        body: messageToSend,
                        from: twilioPhone.value(),
                        to: phoneNumber,
                    });
                })
            );

            const failures = results.filter((r) => r.status === 'rejected');
            failures.forEach((r, i) => {
                if (r.status === 'rejected') {
                    console.error(`Failed to forward SMS to ${otherTeamMembers[i]}:`, r.reason);
                }
            });

            if (failures.length === results.length && results.length > 0) {
                res.status(500).send('Error sending SMS');
                return;
            }

            console.log(`Forwarded to ${results.length - failures.length}/${results.length} team members`);
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
async function sendEmail(subject: string, html: string): Promise<void> {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: gmailUser,
            pass: gmailPass.value()
        }
    });

    const mailOptions = {
        from: 'RichardSV15@gmail.com',  // Sender address from config
        to: recipientEmails.join(', '),   // List of recipients
        subject: subject,                // Subject line
        html: html                       // HTML body
    };

    await transporter.sendMail(mailOptions);
}

/**
 * Sends SMS messages using Twilio.
 *
 * @param {string} body - The SMS message body.
 * @return {Promise<void>} - A promise that resolves when all SMS messages are sent.
 */
async function sendSMS(body: string): Promise<void> {
    const client = twilio(twilioSid.value(), twilioToken.value());
    const results = await Promise.allSettled(
        recipientPhoneNumbers.map((phoneNumber) =>
            client.messages.create({
                body: body,
                from: twilioPhone.value(),
                to: phoneNumber,
            })
        )
    );

    const failures: { number: string; reason: unknown }[] = [];
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            failures.push({ number: recipientPhoneNumbers[i], reason: r.reason });
            console.error(`SMS to ${recipientPhoneNumbers[i]} failed:`, r.reason);
        }
    });

    if (failures.length === recipientPhoneNumbers.length && recipientPhoneNumbers.length > 0) {
        throw new Error(`All SMS sends failed (${failures.length}/${recipientPhoneNumbers.length})`);
    }
}