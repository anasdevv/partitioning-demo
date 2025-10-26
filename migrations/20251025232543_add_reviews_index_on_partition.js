/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.alterTable("reviews_partitioned", (table) => {
    table.index(["product_id", "rating"], "idx_reviews_partitioned_product_rating");
    table.index(["product_id"] , "idx_reviews_partitioned_product");
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.alterTable("reviews_partitioned", (table) => {
    table.dropIndex(["product_id", "rating"], "idx_reviews_partitioned_product_rating");
    table.dropIndex(["product_id"] , "idx_reviews_partitioned_product");
  });
};
