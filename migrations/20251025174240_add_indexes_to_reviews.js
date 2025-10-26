/** @type {import('knex').Knex} */
export async function up(knex) {
  await knex.schema.alterTable("reviews", (table) => {
    table.index("product_id", "idx_reviews_product_id");
    table.index("user_id", "idx_reviews_user_id");
    table.index("rating", "idx_reviews_rating");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("reviews", (table) => {
    table.dropIndex("product_id", "idx_reviews_product_id");
    table.dropIndex("user_id", "idx_reviews_user_id");
    table.dropIndex("rating", "idx_reviews_rating");
  });
}
