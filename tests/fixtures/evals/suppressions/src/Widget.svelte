<script lang="ts">
  // Script comments are prose too: as any.
  export let value: any;
  const label = 'shown as any label';
</script>

<!-- An HTML comment is not a directive: @ts-ignore, as any -->
<p>Note: any item can be returned within 30 days, as unknown as that may sound.</p>
<p>{label}: {(value as any).name}</p>

<style>
  p::after { content: ': any'; }
</style>
