/** @type {import('knex').Knex} */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE reviews_partitioned (
      id SERIAL,
      product_id INT NOT NULL,
      user_id INT NOT NULL,
      rating INT NOT NULL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY (id, product_id)
    ) PARTITION BY HASH (product_id);
  `);

  for (let i = 0; i < 4; i++) {
    await knex.raw(`
      CREATE TABLE reviews_partitioned_p${i} PARTITION OF reviews_partitioned
      FOR VALUES WITH (MODULUS 4, REMAINDER ${i});
    `);
  }

    console.log('Copying data from reviews → reviews_partitioned...');
    await knex.raw(`
      INSERT INTO reviews_partitioned (id, product_id, user_id, rating, comment, created_at)
      SELECT id, product_id, user_id, rating, comment, created_at FROM reviews;
    `);

    // I haven't dropped the original table on purpose but you can do it if you want to
  console.log('✅ Partitioned table reviews_partitioned created successfully');
}

export async function down(knex) {
  console.log('Dropping partitioned table reviews_partitioned...');
  for (let i = 0; i < 4; i++) {
    await knex.raw(`DROP TABLE IF EXISTS reviews_partitioned_p${i};`);
  }
  await knex.raw(`DROP TABLE IF EXISTS reviews_partitioned;`);
}
