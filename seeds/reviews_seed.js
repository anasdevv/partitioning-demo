/** @type {import('knex').Knex} */
export async function seed(knex) {
  const batchSize = 10000; 
  const totalRows = 1_000_000_000;// 1 billion rows
  const totalBatches = Math.ceil(totalRows / batchSize);

  console.log(`Seeding ${totalRows} rows in ${totalBatches} batches...`);

  for (let batch = 0; batch < totalBatches; batch++) {
    const rows = [];
    for (let i = 0; i < batchSize; i++) {
      rows.push({
        product_id: Math.floor(Math.random() * 1000) + 1,
        user_id: Math.floor(Math.random() * 100_000) + 1,
        rating: Math.floor(Math.random() * 5) + 1,
        comment: 'Sample review comment',
        created_at: new Date(),
      });
    }
    await knex('reviews').insert(rows);
    console.log(`Inserted batch ${batch + 1} / ${totalBatches}`);
  }

  console.log('Seeding completed!');
}
