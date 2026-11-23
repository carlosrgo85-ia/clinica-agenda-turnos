import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

export interface CheckListItem {
  id: string;
  label: string;
}

/**
 * Una lista de casillas para elegir varios elementos (los servicios de un
 * profesional, los profesionales de un servicio). `value` son los ids marcados.
 */
export function CheckList(props: {
  idPrefix: string;
  items: CheckListItem[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  function toggle(id: string, marcado: boolean) {
    props.onChange(marcado ? [...props.value, id] : props.value.filter((v) => v !== id));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {props.items.map((item) => (
        <div className="checkbox-field" key={item.id}>
          <Checkbox
            id={`${props.idPrefix}-${item.id}`}
            checked={props.value.includes(item.id)}
            onCheckedChange={(v) => toggle(item.id, v === true)}
          />
          <Label htmlFor={`${props.idPrefix}-${item.id}`}>{item.label}</Label>
        </div>
      ))}
    </div>
  );
}
