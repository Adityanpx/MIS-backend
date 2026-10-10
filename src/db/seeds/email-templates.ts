export const EMAIL_TEMPLATES: Array<{ code: string; channel: 'email'; subject: string; html: string; text: string }> = [
  {
    code: 'AUTH_INVITE_CLIENT', channel: 'email',
    subject: 'You are invited to {{platformName}} ({{companyName}})',
    html: '<p>Hello {{name}},</p><p>You have been invited to <b>{{companyName}}</b> on {{platformName}}.</p>' +
          '<p><a href="{{link}}">Set your password</a> (link valid for {{expiresIn}}).</p>',
    text: 'Hello {{name}},\nYou have been invited to {{companyName}} on {{platformName}}.\n' +
          'Set your password: {{link}} (valid for {{expiresIn}}).',
  },
  {
    code: 'AUTH_RESET_CLIENT', channel: 'email',
    subject: 'Reset your {{platformName}} password',
    html: '<p>Hello {{name}},</p><p><a href="{{link}}">Reset your password</a> (valid for {{expiresIn}}).</p>' +
          '<p>If you did not request this, ignore this email.</p>',
    text: 'Hello {{name}},\nReset your password: {{link}} (valid for {{expiresIn}}).\nIf you did not request this, ignore this email.',
  },
  {
    code: 'AUTH_INVITE_ADMIN', channel: 'email',
    subject: '{{platformName}} Super Admin invitation',
    html: '<p>Hello {{name}},</p><p>You have been added as a Super Admin. <a href="{{link}}">Set your password</a> ' +
          '(valid for {{expiresIn}}). Two-factor authentication will be set up at first login.</p>',
    text: 'Hello {{name}},\nYou have been added as a Super Admin. Set your password: {{link}} (valid for {{expiresIn}}).',
  },
  {
    code: 'AUTH_RESET_ADMIN', channel: 'email',
    subject: 'Reset your {{platformName}} Super Admin password',
    html: '<p>Hello {{name}},</p><p><a href="{{link}}">Reset your password</a> (valid for {{expiresIn}}).</p>',
    text: 'Hello {{name}},\nReset your password: {{link}} (valid for {{expiresIn}}).',
  },
  {
    code: 'AUTH_ACCOUNT_LOCKED', channel: 'email',
    subject: '{{platformName}}: account temporarily locked',
    html: '<p>Hello {{name}},</p><p>Your account was locked for {{minutes}} minutes after several failed sign-in attempts.</p>',
    text: 'Hello {{name}},\nYour account was locked for {{minutes}} minutes after several failed sign-in attempts.',
  },
  {
    code: 'OPS_GENERIC', channel: 'email',
    subject: '{{platformName}}: {{title}}',
    html: '<p>Hello {{name}},</p><p>{{body}}</p><p><a href="{{link}}">Open in {{platformName}}</a></p>',
    text: 'Hello {{name}},\n{{body}}\nOpen: {{link}}',
  },
  {
    code: 'N-B01', channel: 'email',
    subject: 'Invoice {{invoiceNo}} from {{sellerName}}: {{amount}} due on {{dueDate}}',
    html: '<p>Dear {{clientName}},</p><p>Invoice <b>{{invoiceNo}}</b> dated {{invoiceDate}} for <b>{{amount}}</b> has been issued' +
          ' ({{description}}). It is due on <b>{{dueDate}}</b>.</p><p><a href="{{payLink}}">Pay now</a> · ' +
          '<a href="{{billingLink}}">View and download the invoice</a></p><p>Bank transfer details are on the invoice.</p>',
    text: 'Dear {{clientName}},\nInvoice {{invoiceNo}} dated {{invoiceDate}} for {{amount}} has been issued ({{description}}).\n' +
          'Due on {{dueDate}}.\nPay now: {{payLink}}\nView/download: {{billingLink}}',
  },
  {
    code: 'N-B02', channel: 'email',
    subject: 'Reminder: invoice {{invoiceNo}} ({{amount}}) is due in {{days}} day(s)',
    html: '<p>Dear {{clientName}},</p><p>Invoice <b>{{invoiceNo}}</b> with a balance of <b>{{amount}}</b> is due on ' +
          '<b>{{dueDate}}</b>.</p><p><a href="{{payLink}}">Pay now</a> · <a href="{{billingLink}}">Billing</a></p>',
    text: 'Dear {{clientName}},\nInvoice {{invoiceNo}} (balance {{amount}}) is due on {{dueDate}}.\nPay now: {{payLink}}',
  },
  {
    code: 'N-B03', channel: 'email',
    subject: 'Overdue: invoice {{invoiceNo}} ({{amount}}) — please pay by {{payBy}}',
    html: '<p>Dear {{clientName}},</p><p>Invoice <b>{{invoiceNo}}</b> was due on {{dueDate}}. The outstanding balance is ' +
          '<b>{{amount}}</b>. Please pay by <b>{{payBy}}</b> to avoid restriction of the account.</p>' +
          '<p><a href="{{payLink}}">Pay now</a></p>',
    text: 'Dear {{clientName}},\nInvoice {{invoiceNo}} was due on {{dueDate}}. Balance {{amount}}. Pay by {{payBy}} to avoid restriction.\n{{payLink}}',
  },
  {
    code: 'N-B04', channel: 'email',
    subject: '{{plantName}}: account is read-only due to an unpaid invoice',
    html: '<p>Dear {{clientName}},</p><p>The account for <b>{{plantName}}</b> is now <b>read-only</b> because {{amount}} is ' +
          'overdue since {{dueDate}}. Data entry will be restored as soon as the payment is received. If unpaid, the ' +
          'account will be suspended on {{nextDate}}.</p><p><a href="{{payLink}}">Pay now</a></p>',
    text: 'Dear {{clientName}},\n{{plantName}} is read-only: {{amount}} overdue since {{dueDate}}. Suspension on {{nextDate}} if unpaid.\n{{payLink}}',
  },
  {
    code: 'N-B05', channel: 'email',
    subject: '{{plantName}}: account suspended',
    html: '<p>Dear {{clientName}},</p><p>The account for <b>{{plantName}}</b> is <b>suspended</b> ({{amount}} overdue since ' +
          '{{dueDate}}). Only the Billing page is available to your Client Admin. The account will be terminated on ' +
          '<b>{{nextDate}}</b> if the dues remain unpaid.</p><p><a href="{{payLink}}">Pay now</a></p>',
    text: 'Dear {{clientName}},\n{{plantName}} is suspended ({{amount}} overdue since {{dueDate}}). Termination on {{nextDate}}.\n{{payLink}}',
  },
  {
    code: 'N-B06', channel: 'email',
    subject: '{{plantName}}: account terminated',
    html: '<p>Dear {{clientName}},</p><p>The account for <b>{{plantName}}</b> has been <b>terminated</b>. Your Client Admin ' +
          'can download a full data export until <b>{{exportUntil}}</b> from the app.</p><p><a href="{{billingLink}}">Billing</a></p>',
    text: 'Dear {{clientName}},\n{{plantName}} has been terminated. Data export is available until {{exportUntil}}.\n{{billingLink}}',
  },
  {
    code: 'N-B07', channel: 'email',
    subject: 'Payment received: receipt {{receiptNo}} for {{amount}}',
    html: '<p>Dear {{clientName}},</p><p>Thank you. We have received <b>{{amount}}</b> ({{mode}}{{reference}}) on {{paymentDate}}.' +
          '</p><p>Receipt <b>{{receiptNo}}</b> settles: {{settles}}.</p><p><a href="{{billingLink}}">Download the receipt</a></p>',
    text: 'Dear {{clientName}},\nWe received {{amount}} ({{mode}}{{reference}}) on {{paymentDate}}. Receipt {{receiptNo}} settles: {{settles}}.\n{{billingLink}}',
  },
  {
    code: 'N-B08', channel: 'email',
    subject: '{{plantName}}: account reactivated',
    html: '<p>Dear {{clientName}},</p><p>The account for <b>{{plantName}}</b> is <b>active</b> again. Thank you.</p>',
    text: 'Dear {{clientName}},\nThe account for {{plantName}} is active again. Thank you.',
  },
  {
    code: 'N-B09', channel: 'email',
    subject: 'Cheque {{reference}} for {{amount}} was returned unpaid',
    html: '<p>Dear {{clientName}},</p><p>Your cheque <b>{{reference}}</b> for <b>{{amount}}</b> was returned by the bank ' +
          '({{reason}}). The related invoice(s) are open again: {{settles}}.</p><p><a href="{{billingLink}}">Pay online</a></p>',
    text: 'Dear {{clientName}},\nCheque {{reference}} for {{amount}} bounced ({{reason}}). Open again: {{settles}}.\n{{billingLink}}',
  },
  {
    code: 'N-B10', channel: 'email',
    subject: '{{plantName}}: subscription {{status}} on {{endDate}}',
    html: '<p>Dear {{clientName}},</p><p>The {{planName}} subscription for <b>{{plantName}}</b> {{statusText}} on ' +
          '<b>{{endDate}}</b>. Please contact us to renew.</p><p><a href="{{billingLink}}">Billing</a></p>',
    text: 'Dear {{clientName}},\nThe {{planName}} subscription for {{plantName}} {{statusText}} on {{endDate}}. Please renew.',
  },
  {
    code: 'N-B11', channel: 'email',
    subject: 'Credit note {{cnNo}} for {{amount}} against invoice {{invoiceNo}}',
    html: '<p>Dear {{clientName}},</p><p>Credit note <b>{{cnNo}}</b> for <b>{{amount}}</b> has been issued against invoice ' +
          '{{invoiceNo}}. Reason: {{reason}}.</p><p><a href="{{billingLink}}">Billing</a></p>',
    text: 'Dear {{clientName}},\nCredit note {{cnNo}} for {{amount}} against invoice {{invoiceNo}}. Reason: {{reason}}.',
  },
  {
    code: 'N-B12', channel: 'email',
    subject: 'Your data will be deleted on {{deleteOn}}',
    html: '<p>Dear {{clientName}},</p><p>Your account was terminated on {{terminatedOn}}. Operational data (logsheets, ' +
          'settings, users, PDFs) is scheduled for deletion on <b>{{deleteOn}}</b>. Download your data export before then.</p>',
    text: 'Dear {{clientName}},\nOperational data is scheduled for deletion on {{deleteOn}}. Download your export before then.',
  },
  {
    code: 'ADMIN_ALERT', channel: 'email',
    subject: '[{{platformName}} admin] {{code}}: {{title}}',
    html: '<p>{{body}}</p><p><a href="{{link}}">Open in the Super Admin panel</a></p>',
    text: '{{code}}: {{title}}\n{{body}}\n{{link}}',
  },
  {
    code: 'ACT_AS_STARTED', channel: 'email',
    subject: '{{platformName}} support is working in your account',
    html: '<p>Dear {{name}},</p><p>Super Admin <b>{{adminName}}</b> started an <b>edit</b> support session in your ' +
          'account at {{startedAt}} (reason: {{reason}}). Every action is recorded in your audit log.</p>',
    text: 'Dear {{name}},\nSuper Admin {{adminName}} started an edit support session at {{startedAt}} (reason: {{reason}}).',
  },
  {
    code: 'ANNOUNCEMENT', channel: 'email',
    subject: '{{platformName}}: announcement',
    html: '<p>Dear {{name}},</p><p>{{message}}</p>',
    text: 'Dear {{name}},\n{{message}}',
  },
];
