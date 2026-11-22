<script lang="ts">
  import { formatPrice, PRODUCTS } from '../catalog.ts';
</script>

<h1>Storefront</h1>

<ul>
  {#each PRODUCTS as product (product.sku)}
    <li>{product.name}: {formatPrice(product.priceCents)}</li>
  {/each}
</ul>
