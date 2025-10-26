/** @type {import('knex').Knex} */
export async function up(knex) {
  await knex.schema.createTable('reviews', (table) => {
    table.increments('id').primary();
    table.integer('product_id').notNullable();
    table.integer('user_id').notNullable();
    table.integer('rating').notNullable();
    table.text('comment');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('reviews');
}
