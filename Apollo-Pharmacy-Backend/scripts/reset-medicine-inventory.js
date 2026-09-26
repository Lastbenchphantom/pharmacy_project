#!/usr/bin/env node
/**
 * Safe medicine/inventory reset for the admin-controlled inventory redesign.
 *
 * DELETES:
 *   - StockTransaction (medicine-linked audit rows; required before Medicine delete)
 *   - StockBatch
 *   - Medicine
 *   - StockReceiptItem.matchedMedicineId references (SET NULL)
 *
 * PRESERVES:
 *   - StockReceipt rows (historical uploads; status preserved)
 *   - Appointment
 *   - PushSubscription
 *   - Admin auth (env-based; no user table)
 *
 * Usage:
 *   node scripts/reset-medicine-inventory.js --dry-run
 *   node scripts/reset-medicine-inventory.js --confirm
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || !args.has('--confirm');

const count = async (label, sql) => {
	const [row] = await prisma.$queryRawUnsafe(sql);
	const value = Number(row?.c || 0);
	console.log(`  ${label}: ${value}`);
	return value;
};

async function main() {
	console.log('\n=== Medicine / inventory reset ===');
	console.log(dryRun ? 'Mode: DRY RUN (no deletes). Pass --confirm to execute.\n' : 'Mode: CONFIRM — destructive deletes will run.\n');

	console.log('Tables that WILL be affected:');
	console.log('  - StockReceiptItem (matchedMedicineId → NULL only)');
	console.log('  - StockTransaction (DELETE all rows)');
	console.log('  - StockBatch (DELETE all rows)');
	console.log('  - Medicine (DELETE all rows)');
	console.log('\nTables that will NOT be deleted:');
	console.log('  - StockReceipt (preserved as historical records)');
	console.log('  - Appointment');
	console.log('  - PushSubscription');
	console.log('  - Admin credentials (environment secrets)\n');

	console.log('Current counts:');
	const medicineCount = await count('Medicine', 'SELECT COUNT(*)::int AS c FROM "Medicine"');
	const batchCount = await count('StockBatch', 'SELECT COUNT(*)::int AS c FROM "StockBatch"');
	const txCount = await count('StockTransaction', 'SELECT COUNT(*)::int AS c FROM "StockTransaction"');
	const receiptCount = await count('StockReceipt', 'SELECT COUNT(*)::int AS c FROM "StockReceipt"');
	const itemCount = await count('StockReceiptItem', 'SELECT COUNT(*)::int AS c FROM "StockReceiptItem"');
	const matchedCount = await count(
		'StockReceiptItem with matchedMedicineId',
		'SELECT COUNT(*)::int AS c FROM "StockReceiptItem" WHERE "matchedMedicineId" IS NOT NULL',
	);
	await count('Appointment', 'SELECT COUNT(*)::int AS c FROM "Appointment"');
	await count('PushSubscription', 'SELECT COUNT(*)::int AS c FROM "PushSubscription"').catch(() => 0);

	if (dryRun) {
		console.log(`\nDry run complete. Would remove ~${medicineCount} medicines, ${batchCount} batches, ${txCount} transactions.`);
		console.log(`Would detach ${matchedCount} receipt item medicine links. Would preserve ${receiptCount} receipts / ${itemCount} items.`);
		return;
	}

	console.log('\nExecuting reset inside a transaction…');
	const result = await prisma.$transaction(async (tx) => {
		const detached = await tx.$executeRawUnsafe(`
			UPDATE "StockReceiptItem" SET "matchedMedicineId" = NULL, "matchStatus" = 'UNMATCHED'
			WHERE "matchedMedicineId" IS NOT NULL
		`);
		const deletedTx = await tx.$executeRawUnsafe(`DELETE FROM "StockTransaction"`);
		const deletedBatches = await tx.$executeRawUnsafe(`DELETE FROM "StockBatch"`);
		const deletedMedicines = await tx.$executeRawUnsafe(`DELETE FROM "Medicine"`);
		return { detached, deletedTx, deletedBatches, deletedMedicines };
	});

	console.log('\nReset complete:');
	console.log(`  Detached receipt item medicine links: ${result.detached}`);
	console.log(`  Deleted StockTransaction rows: ${result.deletedTx}`);
	console.log(`  Deleted StockBatch rows: ${result.deletedBatches}`);
	console.log(`  Deleted Medicine rows: ${result.deletedMedicines}`);

	console.log('\nPost-reset counts:');
	await count('Medicine', 'SELECT COUNT(*)::int AS c FROM "Medicine"');
	await count('StockBatch', 'SELECT COUNT(*)::int AS c FROM "StockBatch"');
	await count('StockTransaction', 'SELECT COUNT(*)::int AS c FROM "StockTransaction"');
	await count('StockReceipt', 'SELECT COUNT(*)::int AS c FROM "StockReceipt"');
	await count('Appointment', 'SELECT COUNT(*)::int AS c FROM "Appointment"');
}

main()
	.catch((error) => {
		console.error('\nReset failed:', error.message || error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
