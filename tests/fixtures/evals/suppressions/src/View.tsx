export function View(props: { name: string }) {
  return (
    <p title="as any">
      Hello {props.name}: any text here is JSX text, as unknown as it looks.
    </p>
  );
}

export const cast = (props: unknown) => props as any;
